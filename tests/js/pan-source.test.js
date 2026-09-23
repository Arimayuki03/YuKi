'use strict';
/** 单元测试：src/main/pan-source.js — 网盘类源识别（纯函数白盒）。
 *
 *  与 tests/js/pan-source-playlist.test.js 的分工：
 *  - 后者测「业务接入面」（主进程 index.js 消费、渲染层同口径、回退收口）；
 *  - 本文件测「判定面本身」：正则对各类网盘形态的匹配矩阵 + isPanQueueRequest
 *    的三参组合与畸形入参健壮性（后者只覆盖了 4 个粗粒度用例）。 */
const { test } = require('node:test');
const assert = require('node:assert');
const { PAN_SOURCE_RE, isPanQueueRequest } = require('../../src/main/pan-source');

/** 干净的 catvod 建队请求骨架（site/flag/eps 由各用例覆盖）。 */
const q = (over) => Object.assign({ kind: 'catvod', site: '', flag: '', eps: [] }, over);

// ---------------------------------------------------------------- PAN_SOURCE_RE 匹配矩阵

test('PAN_SOURCE_RE：夸克系——域名/大写/纯中文站点名三种形态均命中', () => {
    // 英文域名（quark 强特征为子串匹配，不受邻接边界限制）
    assert.equal(PAN_SOURCE_RE.test('https://pan.quark.cn/s/abc'), true);
    // 大小写：正则带 i 标志，播放器/源站返回的大写主机名同样命中
    assert.equal(PAN_SOURCE_RE.test('HTTPS://PAN.QUARK.CN/S/ABC'), true);
    // 纯中文「夸克云盘」：不命中 quark/pan/网盘 任一既有子串，靠「夸克」「云盘」补充
    assert.equal(PAN_SOURCE_RE.test('夸克云盘'), true);
    assert.equal(PAN_SOURCE_RE.test('夸克网盘'), true);
});

test('PAN_SOURCE_RE：阿里系——alipan/aliyundrive/alidrive/alist 单列命中，普通英文词不误伤', () => {
    // ali 是弱特征（两侧不与字母相邻），alipan/alidrive/alist 加边界后靠单列命中
    assert.equal(PAN_SOURCE_RE.test('https://www.alipan.com/s/x'), true);
    assert.equal(PAN_SOURCE_RE.test('https://www.aliyundrive.com/s/x'), true);
    assert.equal(PAN_SOURCE_RE.test('alidrive'), true);
    assert.equal(PAN_SOURCE_RE.test('https://alist.example.com/d/xx'), true);
    // 单列强特征：aliyun（含 aliyun 子串）
    assert.equal(PAN_SOURCE_RE.test('csp_aliyun'), true);
    // 弱特征边界：ali 邻接 CJK/下划线/点/斜杠仍算边界
    assert.equal(PAN_SOURCE_RE.test('csp_ali'), true);
    assert.equal(PAN_SOURCE_RE.test('do=ali&'), true);
    // 反例（2026-09-22 评审加邻接边界的动机）：普通词里的 ali/pan 子串不得命中
    assert.equal(PAN_SOURCE_RE.test('company'), false);
    assert.equal(PAN_SOURCE_RE.test('Alice'), false);
    assert.equal(PAN_SOURCE_RE.test('japan'), false);
    assert.equal(PAN_SOURCE_RE.test('https://mypan.com/a'), false);
});

test('PAN_SOURCE_RE：115/123 数字串邻接边界——CDN 域名命中，集数/编号不误伤', () => {
    assert.equal(PAN_SOURCE_RE.test('https://115cdn.com/a'), true);
    assert.equal(PAN_SOURCE_RE.test('https://115.com/s/x'), true);
    assert.equal(PAN_SOURCE_RE.test('https://123pan.com/s/x'), true);
    assert.equal(PAN_SOURCE_RE.test('115网盘'), true);
    // 反例：前侧邻接字母/数字（ep115）或后侧邻接数字（1234）均不命中
    assert.equal(PAN_SOURCE_RE.test('ep115'), false);
    assert.equal(PAN_SOURCE_RE.test('1234'), false);
    assert.equal(PAN_SOURCE_RE.test('第1234集'), false, '后侧邻接数字不算边界');
    // 前侧邻接 CJK 仍算边界 → 纯集数形态按旧口径不拦（产品口径，非缺陷）
    assert.equal(PAN_SOURCE_RE.test('第123集'), true);
});

test('PAN_SOURCE_RE：百度/迅雷/UC——pan 子串兜底命中，UC 纯英文域名不在口径内', () => {
    // 百度与迅雷无专属特征，靠 pan 弱特征（两侧不与字母数字相邻）命中
    assert.equal(PAN_SOURCE_RE.test('https://pan.baidu.com/s/1abcd'), true);
    assert.equal(PAN_SOURCE_RE.test('https://pan.xunlei.com/s/x'), true);
    // UC：站点名通常写「UC网盘」，靠「网盘」命中；纯 drive.uc.cn 域名源码未覆盖
    assert.equal(PAN_SOURCE_RE.test('UC网盘'), true);
    assert.equal(PAN_SOURCE_RE.test('https://drive.uc.cn/s/x'), false, 'UC 纯域名当前不在特征集内');
});

test('PAN_SOURCE_RE：天翼/移动以中文特征命中，纯运营商域名不在特征集内', () => {
    assert.equal(PAN_SOURCE_RE.test('天翼云盘'), true);
    assert.equal(PAN_SOURCE_RE.test('移动云盘'), true);
    assert.equal(PAN_SOURCE_RE.test('https://cloud.189.cn/web/share?code=x'), false,
        '189 域名当前无特征（仅「天翼」中文名命中）');
});

test('PAN_SOURCE_RE：普通媒体 URL——子域名/路径/查询串/扩展名均不误伤', () => {
    for (const u of [
        'https://cdn.example.com/v/index.m3u8?sign=abc',
        'https://v.ipcdn.example/2026/01/01/a.mp4',
        'http://127.0.0.1:9978/proxy?do=playerContent&site=csp_demo',
        'https://iqiyi.com/play/1',
        '/detail/1',
        'ep1',
    ]) {
        assert.equal(PAN_SOURCE_RE.test(u), false, `不应命中：${u}`);
    }
    // 已知口径边界（非缺陷，钉住现状）：路径里以斜杠分隔的裸「123」会命中数字特征，
    // 与注释里「第123集 邻接为 CJK 不拦」的取舍同源——集 URL 形态需与产品口径确认。
    assert.equal(PAN_SOURCE_RE.test('https://iqiyi.com/play/123'), true);
});

test('PAN_SOURCE_RE：网盘分享链接带路径与查询串（大小写混合）依然命中', () => {
    // 取链时常带 pwd/from 等查询参数，且主机名大小写不固定
    assert.equal(PAN_SOURCE_RE.test('https://Pan.Baidu.com/s/1aBcD?pwd=abcd&from=copy'), true);
    assert.equal(PAN_SOURCE_RE.test('https://pan.quark.cn/s/abc#/list/share?pwd=zz'), true);
    // 代理/外链里嵌套的分享地址（整串判定，不做分段）
    assert.equal(PAN_SOURCE_RE.test('https://x.com/redir?u=https://pan.quark.cn/s/zz'), true);
});

test('PAN_SOURCE_RE：空值与非字符串入参不抛异常（RegExp.test 走 String() 隐式转换）', () => {
    assert.equal(PAN_SOURCE_RE.test(null), false);
    assert.equal(PAN_SOURCE_RE.test(undefined), false);
    assert.equal(PAN_SOURCE_RE.test(''), false);
    assert.equal(PAN_SOURCE_RE.test(0), false);
    assert.equal(PAN_SOURCE_RE.test({}), false);
    assert.equal(PAN_SOURCE_RE.test([]), false);
    assert.equal(PAN_SOURCE_RE.test(true), false);
    // 数字 123 经 String() 后命中「123」数字特征——隐式转换的既定行为
    assert.equal(PAN_SOURCE_RE.test(123), true);
});

test('PAN_SOURCE_RE：无 g 标志——反复 test 结果稳定、lastIndex 不漂移', () => {
    // 消费方（index.js / 渲染层）共用同一常量实例，带 g 会让交替调用结果跳变
    assert.equal(PAN_SOURCE_RE.flags.includes('g'), false, '不得带 g 标志');
    assert.equal(PAN_SOURCE_RE.test('quark'), true);
    assert.equal(PAN_SOURCE_RE.lastIndex, 0);
    assert.equal(PAN_SOURCE_RE.test('quark'), true);
    assert.equal(PAN_SOURCE_RE.test('csp_demo'), false);
    assert.equal(PAN_SOURCE_RE.test('quark'), true, '第三次仍应命中（无 lastIndex 副作用）');
});

// ---------------------------------------------------------------- isPanQueueRequest 判定矩阵

test('isPanQueueRequest：site / flag / eps 三个判定面任一命中即判为网盘', () => {
    // 面一：站点名
    assert.equal(isPanQueueRequest(q({ site: 'csp_QuarkPan', eps: [{ id: 'fid1' }] })), true);
    // 面二：线路名（站点名干净）
    assert.equal(isPanQueueRequest(q({ site: 'csp_clean', flag: '夸克云盘', eps: [{ id: 'fid1' }] })), true);
    // 面三：各集 id/url（站点与线路都干净）
    assert.equal(isPanQueueRequest(q({ site: 'csp_clean', flag: '剧情',
        eps: [{ id: 'https://pan.baidu.com/s/1a' }] })), true);
});

test('isPanQueueRequest：三参全空放行；干净源（含数字 id）不被拒', () => {
    assert.equal(isPanQueueRequest(q({})), false, 'site/flag/eps 均空 → 拼接串为 "||"');
    assert.equal(isPanQueueRequest(q({ site: 'csp_douban', flag: '剧情',
        eps: [{ id: '/detail/1' }, { id: 'fid2' }] })), false);
    // 短数字 id（12）经 String() 后不命中 123 特征
    assert.equal(isPanQueueRequest(q({ site: 'csp_demo', eps: [{ id: 12 }] })), false);
});

test('isPanQueueRequest：混合链接——普通集里夹一条网盘即整队判为网盘', () => {
    assert.equal(isPanQueueRequest(q({ site: 'csp_clean', flag: 'f',
        eps: [{ id: 'fid1' }, { id: 'https://pan.quark.cn/s/abc' }, { id: 'fid3' }] })), true,
        '只要一集是网盘，整季装载会放大风控，须整队回退逐集');
    // 网盘集排在末尾同样命中（判定不只看首集）
    assert.equal(isPanQueueRequest(q({ site: 'csp_clean', flag: 'f',
        eps: [{ id: 'fid1' }, { id: 'http://127.0.0.1:9978/proxy?do=pan&site=quark' }] })), true);
});

test('isPanQueueRequest：eps 非数组（字符串/对象/null）时跳过集判定且不崩', () => {
    // 非数组 eps 走 '' 分支：只按 site|flag 判定
    assert.equal(isPanQueueRequest(q({ site: 'csp_QuarkPan', eps: 'https://pan.quark.cn/s/x' })), true,
        'eps 非法时仍应能凭站点名拦下');
    assert.equal(isPanQueueRequest(q({ site: 'csp_demo', eps: 'https://pan.quark.cn/s/x' })), false,
        'eps 非法 → 集面不参与判定');
    assert.equal(isPanQueueRequest(q({ site: 'csp_demo', eps: { a: 1 } })), false);
    assert.equal(isPanQueueRequest(q({ site: 'csp_demo', eps: null })), false);
});

test('isPanQueueRequest：eps 元素为 null/undefined/缺 id 时不崩，空串不计入', () => {
    assert.equal(isPanQueueRequest(q({ site: 'csp_demo', eps: [null, undefined, {}] })), false);
    // 元素有 url 但无 id：判定面只取 id（历史字段口径），不误判为网盘
    assert.equal(isPanQueueRequest(q({ site: 'csp_demo',
        eps: [{ url: 'https://pan.quark.cn/s/x' }] })), false);
    // 正常元素与非字符串 id 混排
    assert.equal(isPanQueueRequest(q({ site: 'csp_demo', eps: [{ id: 123 }] })), true,
        '数字 id 123 经 String() 命中数字网盘特征');
});

test('isPanQueueRequest：Kazumi 规则引擎豁免——kind 严格小写 kazumi 才放行', () => {
    assert.equal(isPanQueueRequest({ kind: 'kazumi', site: 'kazumi:阿里嘎多', flag: '',
        eps: [{ id: 'mov-1' }] }), false, '规则名含 ali 不得误伤');
    assert.equal(isPanQueueRequest({ kind: 'kazumi', site: 'kazumi:移动番剧', flag: '',
        eps: [{ id: 'https://pan.quark.cn/s/x' }] }), false, 'Kazumi 整队豁免，集面也不看');
    // 非 kazumi 的 kind 不豁免：规则名里的 alipan 照常命中
    assert.equal(isPanQueueRequest({ kind: 'catvod', site: 'kazumi:alipan剧场', eps: [] }), true);
    // 豁免按 kind 严格小写比较：'Kazumi' / 'KAZUMI' 不在豁免口径内（大小写敏感是现状口径）
    assert.equal(isPanQueueRequest({ kind: 'Kazumi', site: '夸克', eps: [] }), true);
    assert.equal(isPanQueueRequest({ kind: 'KAZUMI', site: '夸克', eps: [] }), true);
});

test('isPanQueueRequest：queue 为 null/undefined/原始值时直接放行且不抛异常', () => {
    assert.equal(isPanQueueRequest(null), false);
    assert.equal(isPanQueueRequest(undefined), false);
    assert.equal(isPanQueueRequest(0), false);
    assert.equal(isPanQueueRequest(''), false);
    assert.equal(isPanQueueRequest([]), false, '数组无 site/flag → 拼接串为空');
});
