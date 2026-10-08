"""划词翻译服务——免费端点（Edge / Google）+ 可选 LLM（OpenAI 兼容）。

协议移植自 auto-translate 扩展（MIT, © 2026 Arimayuki03）的
src/background/providers/{microsoft,googlefree}.ts，要点：

- Microsoft（edge.microsoft.com/translate/translatetext）：POST，body 是
  「裸 JSON 字符串数组」（旧版 [{Text}] 形态会被拒绝）；端点对每次请求跑
  HTML 标签对齐器，正文里裸的 "<" 会被融合成伪标签，因此发送前必须转义
  & < >，返回后解码一次；响应为与请求等长的数组，每项 translations[0].text。
- Google（translate.googleapis.com/translate_a/single）：GET，client=gtx&dt=t
  免 key；响应 data[0] 各段 item[0] 拼接即译文。
- 两个免费通道互为备份：一个被限流（429）或不可达时自动切换另一个。

LLM 走 OpenAI 兼容 /chat/completions（非流式）；baseURL/key/model 由渲染层
按次传入（与 Bangumi token 同策略），本模块不持久化任何凭据。除翻译外，
同一客户端提供 llm_vision_recognize_captcha()（多模态验证码识别，2026-10-01
起作为 kazumi 验证码识别链的第二级，见 kazumi/captcha.py）。

对外入口 translate_text()：mem_cache 命中直接返回；未命中按
LLM(已配置) → microsoft → google 次序执行，单 provider 失败自动降级下一个。
"""

import base64
import hashlib
import json
import logging
import re
import threading
import time

import http_client
import mem_cache

logger = logging.getLogger('yuki.kazumi.translate')

MICROSOFT_ENDPOINT = 'https://edge.microsoft.com/translate/translatetext'
GOOGLE_ENDPOINT = 'https://translate.googleapis.com/translate_a/single'

# 免费端点超时收窄：划词是交互手势，(5, 10) 内不回就降级下一通道
_TRANS_TIMEOUT = (5, 10)
_LLM_TIMEOUT = (10, 30)

# 验证码识别的输出预算（2026-10-08 提升 16 → 320）。
# 答案本身只需 4 个字符，但推理型/遵从指令度低的模型会先输出一段前言
# （实测："The user wants me to read a CAPTCHA with exactly 4 digits.
# Looki…"），16 token 装不下这段就被截断、永远拿不到末尾的答案，表现为
# 设置页测试写「识别为空」（用户实测到的就是这条）。代价：输出 token 极便宜
# 且不随输入计费，换来的是推理型模型可用；真正贵的是图片输入侧。
_CAPTCHA_MAX_TOKENS = 320

# 微软通道单批字符上限：GET/POST body 过大端点会拒（413），按换行拆批
_MS_BATCH_CHARS = 4000

_CACHE_NS = 'translate'
_CACHE_TTL = 86400

_MAX_TEXT = 5000

# mem_cache.DEFAULT_TTL 无该命名空间，进程内注册一次（重复注册无害）
mem_cache.DEFAULT_TTL.setdefault(_CACHE_NS, _CACHE_TTL)

_LAST_MS_AT = [0.0]   # Microsoft 相邻请求最小间隔（免费端点防 429）
_MIN_MS_INTERVAL = 0.3
# run_in_threadpool 多线程调用：限速时间戳的读改写必须持锁（check-then-act 竞态
# 最坏失效间隔触发 429，正确性由 failover 链兜底，这里收紧到原子）
_MS_LOCK = threading.Lock()


class TranslateError(Exception):
    """provider 级失败。message 面向用户展示，code 供日志/诊断分类。"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


# ---------------------------------------------------------------- 语言码

def normalize_lang(lang, *, microsoft=False):
    """目标语言归一。zh 变体按 microsoft 标志分落 zh-Hans/zh-Hant（微软端点
    不认裸 zh）或 zh-CN/zh-TW（Google 码）；裸 zh 无地区码按简体；其余取主码小写。"""
    l = str(lang or '').strip()
    if not l:
        return 'zh-Hans' if microsoft else 'zh-CN'
    if re.match(r'^zh[-_]?(cn|hans|sg)', l, re.I):
        return 'zh-Hans' if microsoft else 'zh-CN'
    if re.match(r'^zh[-_]?(tw|hk|mo|hant)', l, re.I):
        return 'zh-Hant' if microsoft else 'zh-TW'
    if re.fullmatch(r'zh', l, re.I):
        return 'zh-Hans' if microsoft else 'zh-CN'
    return l.split('-', 1)[0].split('_', 1)[0].lower() or ('zh-Hans' if microsoft else 'zh-CN')


def _ms_source_lang(lang):
    """微软端点源语言归一：端点不认裸 zh，必须传具体变体；未知变体按简体。"""
    l = str(lang or '').strip()
    if not l:
        return ''
    primary = l.lower().split('-', 1)[0].split('_', 1)[0]
    if primary == 'zh':
        return 'zh-Hant' if re.match(r'^zh.*(tw|hk|hant)', l, re.I) else 'zh-Hans'
    return primary


# ---------------------------------------------------------------- 转义

def escape_html(text):
    """HTML 实体转义：防裸 < 被微软端点的标签对齐器吃掉（& 必须最先转义）。"""
    return text.replace('&', '&amp;').replace('<', '&lt;').replace('>', '&gt;')


def unescape_html(text):
    """解码一次转义实体（与 escape_html 配对；&amp; 放最后，保证
    &amp;lt; → &lt; 而不是 <）。"""
    return (text.replace('&lt;', '<').replace('&gt;', '>')
                .replace('&quot;', '"').replace('&#39;', "'")
                .replace('&amp;', '&'))


# ---------------------------------------------------------------- providers

def _ms_request(texts, from_lang, to_lang):
    """Microsoft 通道单次请求：返回与 texts 等长的译文数组。"""
    url = '{}?from={}&to={}&isEnterpriseClient=false'.format(
        MICROSOFT_ENDPOINT, from_lang, to_lang)
    # 启动间隔限速：免费端点压低速率防 429（锁内原子预约，sleep 放锁外）
    with _MS_LOCK:
        now = time.monotonic()
        wait = _LAST_MS_AT[0] + _MIN_MS_INTERVAL - now
        _LAST_MS_AT[0] = max(now, _LAST_MS_AT[0] + _MIN_MS_INTERVAL)
    if wait > 0:
        time.sleep(wait)
    rsp = http_client.post(
        url, json=[escape_html(t) for t in texts], timeout=_TRANS_TIMEOUT,
        headers={'Content-Type': 'application/json'})
    if rsp.status_code == 429:
        raise TranslateError('rate_limit', '翻译频率受限（429），请稍后再试')
    if rsp.status_code >= 500:
        raise TranslateError('server', '翻译服务暂不可用（{}）'.format(rsp.status_code))
    if rsp.status_code != 200:
        raise TranslateError('bad_request', '翻译请求失败（{}）'.format(rsp.status_code))
    try:
        data = json.loads(rsp.text)
    except (ValueError, TypeError):
        raise TranslateError('bad_response', '翻译响应不是有效 JSON')
    if not isinstance(data, list) or len(data) != len(texts):
        raise TranslateError('bad_response', '翻译响应段数不符')
    out = []
    for i, item in enumerate(data):
        try:
            out.append(unescape_html(item['translations'][0]['text']))
        except (KeyError, IndexError, TypeError):
            raise TranslateError('bad_response', '翻译第 {} 段返回空结果'.format(i + 1))
    return out


def microsoft_translate(text, to_lang, from_lang=''):
    """Microsoft 免 key 通道。from_lang 留空 = 端点自动检测。

    超长文本拆批：端点对超长请求体可能拒绝，每批 _MS_BATCH_CHARS 字符
    （batch 间共享同一响应段数校验——逐批独立请求）。"""
    to = normalize_lang(to_lang, microsoft=True)
    frm = _ms_source_lang(from_lang)
    batches, cur, cur_len = [], [], 0
    # 超长单段（>单批上限）独占一批，由上游 5000 字上限兜底不再切分
    for para in text.split('\n'):
        if cur and cur_len + len(para) > _MS_BATCH_CHARS:
            batches.append(cur)
            cur, cur_len = [], 0
        cur.append(para)
        cur_len += len(para) + 1
    if cur:
        batches.append(cur)
    out = []
    for batch in batches:
        out.extend(_ms_request(batch, frm, to))
    return '\n'.join(out)


def google_translate(text, to_lang, from_lang='auto'):
    """Google 免 key 通道（translate_a/single）。"""
    url = GOOGLE_ENDPOINT
    params = {'client': 'gtx', 'dt': 't', 'sl': from_lang or 'auto',
              'tl': normalize_lang(to_lang, microsoft=False), 'q': text}
    rsp = http_client.get(url, params=params, timeout=_TRANS_TIMEOUT)
    if rsp.status_code == 429:
        raise TranslateError('rate_limit', '翻译频率受限（429），请稍后再试')
    if rsp.status_code >= 500:
        raise TranslateError('server', '翻译服务暂不可用（{}）'.format(rsp.status_code))
    if rsp.status_code != 200:
        raise TranslateError('bad_request', '翻译请求失败（{}）'.format(rsp.status_code))
    try:
        data = json.loads(rsp.text)
    except (ValueError, TypeError):
        raise TranslateError('bad_response', '翻译响应不是有效 JSON')
    if not isinstance(data, list) or not isinstance(data[0] if data else None, list):
        raise TranslateError('bad_response', '翻译响应格式异常')
    translated = ''.join(
        item[0] for item in data[0] if isinstance(item, (list, tuple)) and item
        and isinstance(item[0], str))
    if not translated:
        raise TranslateError('bad_response', '翻译返回空结果')
    return translated


_LLM_PROMPT = ('You are a translator. Translate the user text into {target}. '
               'Output ONLY the translation, no explanations, no quotes.')

# 验证码识别提示词：只许 4 位数字、拒绝猜测编造——站点 verify_check 会在
# 提交时判卷，宁缺毋滥（返回空/非 4 位数字按识别失败处理，交由下一级兜底）。
_CAPTCHA_PROMPT = ('This image is a CAPTCHA: exactly 4 digits (0-9), stylized '
                   'italic script, possibly touching strokes. Read them and '
                   'output ONLY the 4 digits, nothing else. If you cannot read '
                   'the image reliably, output nothing.')


def extract_captcha_digits(text):
    """从视觉模型回复中提取 4 位数字验证码；提取不出返回空串。

    提示词虽然要求「只输出 4 位数字」，实测中文多模态模型常无视之回复
    「验证码是1797」「图片中的数字是1797」——提取必须扛住这些形态
    （2026-10-03 用户实测：模型读对了、提取失败，设置页测试误报「识别为空」，
    生产链同源 bug 曾把读对的回复整体降级人工窗口）：

      1. 全角数字归一（ｇｐｔ/qwen 偶发全角输出：１７９７ → 1797）；
      2. 4 位数字提取用「两侧非数字」界定而非 ``\\b``——Python 的 ``\\w``
         匹配汉字，「是1797」在「是」与「1」之间没有词边界，``\\b`` 会整体
         漏匹配（bug 根因）；
      3. 一级提取失败再试空格分位（「1 7 9 7」）：去空格后重复同口径提取
         （去空格不能先行——「12 34」会把两位组粘成 4 位假答案）。

    **多候选优先取末尾**（2026-10-08 修复「回复慢被截断」误报）：
    max_tokens 预算不足时回复被截断，模型的前半段常是推理前言
    （"The user wants me to read a CAPTCHA with exactly 4 digits..."），
    真正的答案落在**最后**。旧口径取首个匹配会把前言里偶现的数字串（年份、
    列举的数字）当答案并对（提取 4 位成功后直接 return），这是空答案之外的
    第二类错提取。故改为收集全部候选、优先取最后一个；多个不同候选时日志
    留痕。副作用可控：短回答（占绝大多数）只有一个候选，行为不变。

    本函数是生产链（llm_vision_recognize_captcha）与设置页测试
    （captcha_probe._probe_llm）的共享提取口径：两侧对同一回复必须给出
    同一答案，否则「测试通过、线上失败」。"""
    t = str(text or '').strip()
    if not t:
        return ''
    # 全角数字/全角负号归一（ASCII 之外仅处理数字域，不动其他字符）
    t = t.translate(str.maketrans('０１２３４５６７８９', '0123456789'))
    if _find(t):
        candidates = re.findall(r'(?<!\d)(\d{4})(?!\d)', t)
        _log_multi(candidates)
        return candidates[-1]
    # 二级：空格分位形态（1 7 9 7）——去空格后同口径重试
    squeezed = re.sub(r'\s+', '', t)
    if squeezed != t:
        if _find(squeezed):
            candidates = re.findall(r'(?<!\d)(\d{4})(?!\d)', squeezed)
            _log_multi(candidates)
            return candidates[-1]
    return ''


def _find(s):
    """串内是否存在「两侧非数字」的 4 位数字段（一级/二级共用的存在性判据）。"""
    return re.search(r'(?<!\d)(\d{4})(?!\d)', s) is not None


def _log_multi(candidates):
    """多个互异候选时留痕（用于事后判断是否需要收紧提示词）。"""
    if len(set(candidates)) > 1:
        logger.info('[kazumi] 验证码提取命中多候选 %r，按「答案在末尾」取 %r',
                    candidates, candidates[-1])


def guess_image_mime(data):
    """按图片魔数嗅探真实 MIME（L10）：data URL 若写死 image/png 而源是
    JPEG/GIF/WebP，部分端点按声明解析失败。对齐 server._guess_image_type 的
    口径（不 import server，独立小函数）；未知/空数据回落 image/png——
    本模块消费方（验证码链）历史上均为 PNG。"""
    raw = bytes(data or b'')
    if raw[:2] == b'\xff\xd8\xff':
        return 'image/jpeg'
    if raw[:8] == b'\x89PNG\r\n\x1a\n':
        return 'image/png'
    if raw[:6] in (b'GIF87a', b'GIF89a'):
        return 'image/gif'
    if raw[:4] == b'RIFF' and raw[8:12] == b'WEBP':
        return 'image/webp'
    return 'image/png'


def extract_vision_text(data):
    """从 OpenAI 兼容 /chat/completions 响应体提取正文文本（M4）。

    生产链与探测侧**唯一共享**的响应解析口径——此前生产链只取
    ``choices[0].message.content``（字符串），思考型模型把正文放
    reasoning_content、部分网关把多模态 content 回成分段数组，探测侧
    都兼容而生产链一律「识别为空」→ 测试通过、线上失败。两侧必须同源。

    兼容形态：
      - content 为字符串（OpenAI 标准态）；
      - content 为分段数组 [{'type':'text','text':…}, …]（部分网关形态）；
      - content 为空时回落 reasoning_content（o1/qwen-thinking 等）。
    提取不出返回空串（交由各调用方按「识别为空」处理）。"""
    try:
        msg = data['choices'][0]['message']
    except (KeyError, IndexError, TypeError):
        return ''
    raw = msg.get('content')
    if isinstance(raw, list):
        raw = ''.join(str(p.get('text') or '') for p in raw if isinstance(p, dict))
    content = str(raw or '').strip()
    if not content:
        content = str(msg.get('reasoning_content') or '').strip()
    return content


def llm_vision_recognize_captcha(image_b64, llm_cfg):
    """视觉 LLM 识别验证码：OpenAI 兼容 /chat/completions 多模态消息。

    image_b64: 裸 base64（不含 data: 前缀）；llm_cfg: {base, key, model}，
    与 llm_translate 同一套用户配置（划词翻译设置面板）。识别失败/配置缺失
    抛 TranslateError，由调用方（captcha 识别链）吞掉降级。
    模型需支持 image_url/base64 输入；文本型模型会报错 → 同样走降级。"""
    base = str((llm_cfg or {}).get('base') or '').strip().rstrip('/')
    key = str((llm_cfg or {}).get('key') or '').strip()
    model = str((llm_cfg or {}).get('model') or '').strip()
    if not base or not model:
        raise TranslateError('bad_request', 'LLM 未配置完整（baseURL/model）')
    img_b64 = str(image_b64 or '').strip()
    if not img_b64:
        raise TranslateError('bad_request', 'empty image')
    # data URL MIME 按魔数嗅探而非写死 image/png（L10）：源可能是 JPEG/GIF/
    # WebP，部分端点按声明 MIME 解析图片。
    try:
        img_raw = base64.b64decode(img_b64, validate=False)
    except (ValueError, TypeError):
        raise TranslateError('bad_request', 'invalid image base64')
    data_url = 'data:{};base64,'.format(guess_image_mime(img_raw)) + img_b64
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    body = {
        'model': model,
        'messages': [
            {'role': 'user', 'content': [
                {'type': 'text', 'text': _CAPTCHA_PROMPT},
                {'type': 'image_url', 'image_url': {'url': data_url}},
            ]},
        ],
        'temperature': 0.0,   # 判读类任务：贪心解码，保证可复现
        'max_tokens': _CAPTCHA_MAX_TOKENS,
        'stream': False,
    }
    rsp = http_client.post(base + '/chat/completions', json=body, timeout=_LLM_TIMEOUT,
                           headers=headers)
    if rsp.status_code == 401 or rsp.status_code == 403:
        raise TranslateError('auth', 'LLM 鉴权失败（{}）'.format(rsp.status_code))
    if rsp.status_code == 429:
        raise TranslateError('rate_limit', 'LLM 频率受限（429）')
    if rsp.status_code >= 500:
        raise TranslateError('server', 'LLM 服务暂不可用（{}）'.format(rsp.status_code))
    if rsp.status_code != 200:
        raise TranslateError('bad_request', 'LLM 请求失败（{}）'.format(rsp.status_code))
    try:
        data = json.loads(rsp.text)
        # 解析口径与探测侧同源（extract_vision_text）：兼容 content 分段数组
        # 与 reasoning_content 兜底，思考型模型不再「测试通过、线上失败」。
        content = extract_vision_text(data)
    except (ValueError, TypeError):
        raise TranslateError('bad_response', 'LLM 响应格式异常')
    content = str(content).strip()
    # 提取：模型常无视「只输出数字」的指令（「验证码是1797」等），走共享
    # 提取口径（全角归一 + 非数字边界 + 空格分位重试，详见函数 docstring）。
    # 返回空串按「模型没读出来」处理，调用方（captcha 识别链）校验不过即降级。
    return extract_captcha_digits(content)


def llm_translate(text, to_lang, llm_cfg):
    """OpenAI 兼容 /chat/completions（非流式）。llm_cfg: {base, key, model}。"""
    base = str((llm_cfg or {}).get('base') or '').strip().rstrip('/')
    key = str((llm_cfg or {}).get('key') or '').strip()
    model = str((llm_cfg or {}).get('model') or '').strip()
    if not base or not model:
        raise TranslateError('bad_request', 'LLM 翻译未配置完整（baseURL/model）')
    headers = {'Content-Type': 'application/json'}
    if key:
        headers['Authorization'] = 'Bearer ' + key
    body = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': _LLM_PROMPT.format(target=to_lang)},
            {'role': 'user', 'content': text},
        ],
        'temperature': 0.2,
        'stream': False,
    }
    rsp = http_client.post(base + '/chat/completions', json=body, timeout=_LLM_TIMEOUT,
                           headers=headers)
    if rsp.status_code == 401 or rsp.status_code == 403:
        raise TranslateError('auth', 'LLM 鉴权失败（{}），请检查 API Key'.format(rsp.status_code))
    if rsp.status_code == 429:
        raise TranslateError('rate_limit', 'LLM 频率受限（429），请稍后再试')
    if rsp.status_code >= 500:
        raise TranslateError('server', 'LLM 服务暂不可用（{}）'.format(rsp.status_code))
    if rsp.status_code != 200:
        raise TranslateError('bad_request', 'LLM 请求失败（{}）'.format(rsp.status_code))
    try:
        data = json.loads(rsp.text)
        content = data['choices'][0]['message']['content']
    except (ValueError, TypeError, KeyError, IndexError):
        raise TranslateError('bad_response', 'LLM 响应格式异常')
    content = str(content).strip()
    if not content:
        raise TranslateError('bad_response', 'LLM 返回空结果')
    return content


# ---------------------------------------------------------------- 编排

def translate_text(text, to_lang='zh-CN', from_lang='', prefer='', llm_cfg=None):
    """主入口：缓存 → provider 链。返回 dict（code=0 成功 / 非 0 全链失败）。

    provider 链：prefer='llm' 且 LLM 已配置时先 LLM；其后固定
    microsoft → google 免费互备。单 provider 失败降级下一个，全失败时
    汇总最后一个错误返回 code=1。

    重试口径（review01 L4 复核，2026-10-01）：本链**无同址重试**——每个
    provider 单次尝试，4xx（400/401/403/404 等）与 429/5xx 均当场抛
    TranslateError 立即降级下一通道（超长文本拆批后任一批 4xx 同样整体
    快速失败，不重发其余批）。最坏耗时 = 各 provider 单次超时之和：
    LLM(10+30)s + microsoft(5+10)s + google(5+10)s ≈ 70s，无退避累加。
    （review01 L4 所指 53s 双基址×2 次重试矩阵在 kazumi/plugin_manager.py
    bangumi_me，不在本模块。）"""
    text = str(text or '').strip()
    if not text:
        return {'code': 1, 'msg': 'empty text'}
    if len(text) > _MAX_TEXT:
        return {'code': 1, 'msg': 'text too long (max {} chars)'.format(_MAX_TEXT)}

    target = to_lang or 'zh-CN'
    llm_ready = bool(llm_cfg and str(llm_cfg.get('model') or '').strip()
                     and str(llm_cfg.get('base') or '').strip())

    # 探测模式（设置页「测试连接」）：只走 LLM 单通道、不 failover、不缓存、
    # 不降级免费通道——失败原样返回错误分类（auth/rate_limit/network/…），
    # 成功返回耗时。让用户区分「配置错误」与「网络不通」。
    if prefer == 'probe':
        started = time.monotonic()
        try:
            if not llm_ready:
                return {'code': 1, 'probe': True, 'err': 'bad_request',
                        'msg': 'LLM 配置不完整（需 baseURL 与 model）'}
            out = llm_translate(text or 'hi', target, llm_cfg)
            return {'code': 0, 'probe': True, 'provider': 'llm', 'text': out,
                    'ms': round((time.monotonic() - started) * 1000)}
        except TranslateError as e:
            return {'code': 1, 'probe': True, 'err': e.code, 'msg': e.message}
        except Exception as e:
            return {'code': 1, 'probe': True, 'err': 'network', 'msg': str(e)}

    # 超长文本：GET 模式的 Google 端点 URL 超限必拒（400/413），微软 POST 通道
    # 无此限制（内部还会拆批）——链中跳过 Google。LLM 同样无 URL 限制。
    # 阈值按 UTF-8 字节数判定（URL 超限取决于 percent-encode 后的字节数而非
    # 字符数，emoji 每字 4 字节）：translate_a/single GET URL 实测 ~13KB 内可用，
    # 4000 字节留余量。
    long_text = len(text.encode('utf-8')) > 4000
    chain = []
    if prefer == 'llm' and llm_ready:
        chain.append('llm')
    chain.append('microsoft')
    if not long_text:
        chain.append('google')

    key = hashlib.sha1('{}|{}|{}|{}'.format(
        '+'.join(chain), from_lang or '', target, text).encode('utf-8')).hexdigest()
    cached = mem_cache.get_value(_CACHE_NS, key)
    if cached is not None:
        try:
            hit = json.loads(cached)
            if isinstance(hit, dict) and hit.get('code') == 0:
                hit['cached'] = True
                return hit
        except (ValueError, TypeError):
            pass  # 缓存条目损坏按未命中处理

    last_err = None
    for name in chain:
        try:
            started = time.monotonic()
            if name == 'llm':
                out = llm_translate(text, target, llm_cfg)
            elif name == 'microsoft':
                out = microsoft_translate(text, target, from_lang)
            else:
                out = google_translate(text, target, from_lang or 'auto')
            result = {
                'code': 0, 'text': out, 'provider': name,
                'to': target, 'ms': round((time.monotonic() - started) * 1000),
            }
            mem_cache.set_value(_CACHE_NS, key, json.dumps(result, ensure_ascii=False),
                                ttl=_CACHE_TTL)
            return result
        except TranslateError as e:
            last_err = e
        except Exception as e:  # 网络层异常统一按降级处理
            last_err = TranslateError('network', str(e))
    return {'code': 1, 'msg': last_err.message if last_err else 'no provider'}
