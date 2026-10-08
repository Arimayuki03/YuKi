# -*- coding: utf-8 -*-
"""目标站真实验证码采样器：取图 + 「站点判题」自动标注（零错标数据集）。

用法（开发机一次性，数据只落 .review-tmp/，不进 git）：
    python-backend/.venv/Scripts/python.exe python-backend/tools/sample_captcha_site.py \
        --site mutefun --count 200 --out .review-tmp/captcha_data/mutefun

标注协议（关键设计——用站点本身当判题器）：
  1. 独立会话 GET 搜索页建会话（答案绑会话，与 solve_captcha 同机制）；
  2. GET /index.php/verify/index.html 取验证码图；
  3. ddddocr 识别为候选标注，字符域/长度校验不过直接丢弃（不提交，
     省一次站点请求 + 不留坏会话）；
  4. 候选 POST /index.php/ajax/verify_check（type=search&verify=<码>）：
     code==1 → 会话标注 100% 正确（站点权威判定），保存 raw 图 + 标注；
     否则丢弃。会话一次性，不复用。

由此得到的数据集错标率 ≈ 0（识别错了站点会拒绝），且天然就是「训练分布 =
真实站点分布」。采样节奏限速（--gap 默认 1.2s，纯串行），尊重站点频率窗；
样本总量受 --count 上界与 --max-tries 默认值双重约束，不构成站点轰炸。
"""
import argparse
import json
import os
import sys
import time

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.dirname(HERE)
sys.path.insert(0, BACKEND)

SITES = {
    # 仅供本仓库验证码识别链的本地样本采集/训练评估使用（tiny-CNN 真实数据集）。
    # 采集必须限速串行（--gap 默认 1.2s + 会话间 sleep），严禁并发/大批量请求——
    # 这是第三方站点，样本量按训练所需最小集取用（--count 默认 200，上限 2000）。
    'mutefun': {
        'base': 'https://www.mutefun.tv',
        'page': 'https://www.mutefun.tv/vodsearch/-------------.html?wd=',
    },
    'mgnacg': {
        'base': 'https://www.mgnacg.com',
        'page': 'https://www.mgnacg.com/search/-------------/?wd=',
    },
    'girigirilove': {
        'base': 'https://ani.girigirilove.com',
        'page': 'https://ani.girigirilove.com/search/-------------/?wd=',
    },
}

# 样本采集安全上界：--count 超过该值拒绝执行（防误操作把采样器当批量请求器）。
# 真实数据集 1900+ 张即收敛到验收门槛（见 train_captcha_real.py），2000 已有足量余量。
MAX_COUNT = 2000
# 单次运行尝试会话数上限（--max-tries 不传时的默认值）：每会话固定 3 次站点
# 请求（搜索页 + 取图 + 判题），2000 次尝试 ≈ 6000 请求，即使成功率极低也
# 不会演变成对站点的无界轰炸；需要更多样本请显式传更大的 --max-tries。
DEFAULT_MAX_TRIES = 2000

VERIFY_IMAGE = '/index.php/verify/index.html'
VERIFY_CHECK = '/index.php/ajax/verify_check'

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36')


def looks_like_image(content):
    magic = (b'\x89PNG', b'\xff\xd8\xff', b'GIF8', b'RIFF')
    return bool(content) and any(content.startswith(m) for m in magic)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--site', required=True, choices=sorted(SITES))
    ap.add_argument('--count', type=int, default=200,
                    help='目标入库样本数（默认 200，上限 %d，超出拒绝执行）' % MAX_COUNT)
    ap.add_argument('--max-tries', type=int, default=DEFAULT_MAX_TRIES,
                    help='最大尝试会话数（默认 %d；仅防无界循环，需更多请显式调大）'
                         % DEFAULT_MAX_TRIES)
    ap.add_argument('--out', required=True)
    ap.add_argument('--gap', type=float, default=1.2, help='两次站点请求间隔秒')
    args = ap.parse_args()

    if args.count > MAX_COUNT:
        ap.error(f'--count={args.count} 超过安全上界 {MAX_COUNT}（单站采样量按训练'
                 f'所需最小集取用；确需更多请分多次运行或修改本脚本 MAX_COUNT）')
    if args.count < 1:
        ap.error('--count 必须 >= 1')

    site = SITES[args.site]
    os.makedirs(args.out, exist_ok=True)
    os.makedirs(os.path.join(args.out, 'rejected'), exist_ok=True)
    manifest_path = os.path.join(args.out, 'manifest.json')
    manifest = []
    if os.path.isfile(manifest_path):
        with open(manifest_path, encoding='utf-8') as f:
            manifest = json.load(f)

    # ddddocr 已从 requirements 移除（L3）：本工具是开发机一次性脚本，依赖
    # 按需自装；干净 venv 缺依赖时清晰报错退出，而不是 ImportError 崩栈。
    # （候选标注替代方案：kazumi tiny-CNN——但其权重只在真实站点分布上可用，
    # 而真实站点分布正要靠本工具采集，冷启动阶段仍需 ddddocr。）
    try:
        import ddddocr
    except ImportError:
        print('缺少依赖 ddddocr：请先 pip install ddddocr（该包已从 requirements '
              '移除，仅供本采样工具按需使用），或改用 kazumi tiny-CNN 候选标注。')
        sys.exit(2)
    ocr = ddddocr.DdddOcr(show_ad=False)

    saved = len(manifest)
    tries = 0
    stats = {'session_fail': 0, 'image_fail': 0, 'implausible': 0, 'rejected': 0}
    while saved < args.count:
        if args.max_tries and tries >= args.max_tries:
            print('max-tries reached, stop')
            break
        tries += 1
        sess = requests.Session()
        sess.trust_env = False
        headers = {'referer': site['base'] + '/', 'user-agent': UA}
        try:
            r = sess.get(site['page'], headers=headers, timeout=(5, 10))
            time.sleep(args.gap)
            r = sess.get(site['base'] + VERIFY_IMAGE, headers=headers, timeout=(5, 10))
            content = r.content or b''
            if r.status_code != 200 or not looks_like_image(content):
                stats['image_fail'] += 1
                print(f'[{tries}] image fail: status={r.status_code} len={len(content)}')
                continue
        except Exception as e:
            stats['session_fail'] += 1
            print(f'[{tries}] session fail: {e}')
            time.sleep(3)
            continue

        # 候选标注：ddddocr + 合法性校验
        try:
            cand = str(ocr.classification(content) or '').strip()
        except Exception as e:
            print(f'[{tries}] ocr fail: {e}')
            continue
        if len(cand) != 4 or not cand.isalnum():
            stats['implausible'] += 1
            continue

        # 站点判题：code==1 才入库
        try:
            cr = sess.post(site['base'] + VERIFY_CHECK,
                           data={'type': 'search', 'verify': cand},
                           headers={**headers, 'x-requested-with': 'XMLHttpRequest'},
                           timeout=(5, 10))
            body = {}
            try:
                body = json.loads((cr.text or '').strip() or '{}')
            except Exception:
                pass
            if body.get('code') != 1:
                stats['rejected'] += 1
                # 难例池：站点拒绝 = ddddocr 认错的图（标注不可信，留待人工
                # 复核）。这些样本绝不能混进训练集，但也不能丢——简单样本
                # 偏置会让模型学不到难字形。
                with open(os.path.join(args.out, 'rejected',
                                       f'{args.site}_{tries:05d}_{cand}.png'), 'wb') as f:
                    f.write(content)
                print(f'[{tries}] rejected: {cand} resp={cr.text[:80]!r}')
                continue
        except Exception as e:
            print(f'[{tries}] check fail: {e}')
            time.sleep(3)
            continue

        name = f'{args.site}_{saved:05d}_{cand}.png'
        with open(os.path.join(args.out, name), 'wb') as f:
            f.write(content)
        manifest.append({'file': name, 'text': cand, 'site': args.site})
        with open(manifest_path, 'w', encoding='utf-8') as f:
            json.dump(manifest, f, ensure_ascii=False, indent=1)
        saved += 1
        if saved % 25 == 0:
            print(f'[{tries}] saved {saved}/{args.count} stats={stats}')
        time.sleep(args.gap)

    print(f'DONE saved={saved} tries={tries} stats={stats}')


if __name__ == '__main__':
    main()
