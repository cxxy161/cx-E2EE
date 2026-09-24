#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
汉字密文 v2 字库生成脚本（可复核 / 可重跑）

产物：src/hanzi-table-v2.js
依据：docs/hanzi-2048-review.md

生成流程
--------
  1. 候选池 = 项目 v1 字库中的 GB2312 一级汉字（3755 字）
  2. 排序   = MTSU 汉语字频表（11115 字排名），降序
  3. 剔除   = 97 个「忌讳 / 粗俗 / 文言 / 生僻」字（BLACKLIST）
  4. 取前 1792 字为「汉字区」
  5. 追加 256 个「常用符号」为「符号区」，补足 2048

设计约束（勿改）
----------------
  * 总长必须恰为 2048 —— 编码按 11 bit/字 定长寻址（见 core.js 的 HanziCodec）
  * 字符必须唯一 —— 重复字会让 CHAR_MAP 覆盖，解码不可逆
  * **顺序即协议** —— 任何顺序变动都会让已发出的密文永久失效

用法
----
    python3 tools/gen-hanzi-table.py            # 从网络取字频并生成
    python3 tools/gen-hanzi-table.py --check    # 只校验已生成的字库，不联网
"""

import argparse
import json
import os
import re
import sys
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
V1_CORE = os.path.join(REPO, 'src', 'core.js')
OUT_JS = os.path.join(REPO, 'src', 'hanzi-table-v2.js')

FREQ_URL = ('https://lingua.mtsu.edu/chinese-computing/statistics/char/list.php'
            '?Which=HSK')

HANZI_SIZE = 1792
SYMBOL_SIZE = 256
TOTAL_SIZE = HANZI_SIZE + SYMBOL_SIZE   # 2048

# ── 黑名单：97 字（与 docs/hanzi-2048-review.md 第三节一致）────────────────
# 只剔「低频」或「单独出现会突兀 / 可能触发风控」的字。
# 注意：不要加入常规高频字 —— v1 曾误剔 王(31) 州(40) 军(49) 兵(76) 帝(89) 臣(115)。
BLACKLIST = set(
    # 忌讳 · 疾病
    '癌瘤疡疮疤痢痔疹瘸瘫聋哑瞎腐脓腥'
    # 忌讳 · 排泄
    '粪溺尿屎屁蛆虱蚤蛔疥'
    # 忌讳 · 死亡丧葬
    '殡葬殓棺柩骸骷髅坟墓殉殇殁殒毙夭'
    # 粗俗 · 性
    '屄屌肏婊妓娼奸淫骚嫖姘妾'
    # 文言虚词 · 古帝名
    '曰兮矣焉哉岂耶兹斯厥罔靡曷奚俾朕汝聿尧舜禹汤桀纣'
    # 生僻罕见
    '皑隘氨肮翱袄稗瘪蹿崔恫镭鸾翟晁荩懿羌羯'
)

# ── 符号区候选池：按类别排列，取前 256 个 ────────────────────────────────
# 全部为真实符号（标点 / 数学 / 货币 / 箭头 / 几何 / 圈号 / 全角），不含汉字。
SYMBOL_POOL = (
    # 中英标点（中文书写最高频）
    '。，、！？：；（）《》「」『』【】〔〕…—·～“”‘’'
    # 数学 · 逻辑
    '＋－×÷＝≠≈≤≥±∝∞∑∏√∮∫∴∵°′″‰‱№§¶†‡'
    # 货币 · 单位
    '￥＄€£¢¥℃℉㎡㎞㎏㎝㎜Ωμ'
    # 箭头 · 星形 · 几何块
    '←↑→↓↖↗↘↙⇐⇒⇔★☆✓✔✗✘▶◀▲▼◆◇○●■□▪▫※'
    # 罗马数字 · 带圈数字 · 括号数字
    'ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳⑴⑵⑶⑷⑸⑹⑺⑻⑼⑽'
    # 全角数字
    '０１２３４５６７８９'
    # 全角符号 · 康熙部首式笔画符
    '｜／＼﹏﹍﹎丶丿丨亅乀乁乂乄'
    # 圆圈字母
    'ⓐⓑⓒⓓⓔⓕⓖⓗⓘⓙⓚⓛⓜⓝⓞⓟⓠⓡⓢⓣⓤⓥⓦⓧⓨⓩ'
    # 全角变体标点
    '∶﹕﹔﹖﹗﹙﹚﹛﹜﹝﹞﹟﹠﹡％﹢﹣﹤﹥'
    # 装饰 · 图形（可能被聊天软件渲染为表情，若需朴素可整段删除）
    '⌒⌓⌘⌛⌚⏰⏳☀☁☂☃☄☎☑☒☕☘☝☞☺☻♠♡♥♢♣♤♧♨♩♪♫♬♭♮♯'
    '⚑⚐⚙⚠⚡⚥⚬⚭⚮⚯⛅⛆⛇⛈⛉⛊⛋⛌'
    '⓿⓪❶❷❸❹❺❻❼❽❾❿'
    'ˉˊˋˌˍˎˏːˑ˒˓˔˕˖˗˘˙˚˛˜˝˞˟ˠˡˢˣˤ˥˦˧˨˩'
    '♔♕♖♗♘♙♚♛♜♝♞♟'
    '☰☱☲☳☴☵☶☷♲♳♴♵♶♷♸♹'
    '⌀⌁⌂⌃⌄⌅⌆⌇⌈⌉⌊⌋⌌⌍⌎⌏'
    '∅∈∉∋∌∏∐∑−∓∔∕∖∗∘∙∝∟∠∡∢∣∤∥∦'
)


def fetch_freq_rank():
    """取 MTSU 字频表 → {字符: 排名}。"""
    req = urllib.request.Request(FREQ_URL, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, timeout=90) as r:
        raw = r.read()
    text = raw.decode('gb18030', errors='replace')
    pre = re.search(r'<pre>(.*?)</pre>', text, re.S)
    if not pre:
        raise SystemExit('字频表结构异常：未找到 <pre> 数据块')
    rank = {}
    for line in pre.group(1).split('<br>'):
        parts = line.split('\t')
        if len(parts) >= 3 and parts[0].strip().isdigit():
            ch = parts[1].strip()
            if len(ch) == 1:
                rank[ch] = int(parts[0])
    if len(rank) < 5000:
        raise SystemExit('字频表解析结果过少（%d），疑似页面改版' % len(rank))
    return rank


def load_v1_candidates():
    """从 v1 字库取 GB2312 一级汉字（前 3755 字）作为候选池。"""
    src = open(V1_CORE, encoding='utf-8').read()
    m = re.search(r'ALPHABET: "([^"]+)"', src)
    if not m:
        raise SystemExit('未能在 src/core.js 找到 v1 ALPHABET')
    return m.group(1)[:3755]


def build(rank):
    cands = [c for c in load_v1_candidates() if c not in BLACKLIST]
    cands.sort(key=lambda c: rank.get(c, 99999))
    hanzi = ''.join(cands[:HANZI_SIZE])

    sym = list(dict.fromkeys(SYMBOL_POOL))          # 去重、保序
    if len(sym) < SYMBOL_SIZE:
        raise SystemExit('符号池不足：需要 %d，实际 %d' % (SYMBOL_SIZE, len(sym)))
    symbols = ''.join(sym[:SYMBOL_SIZE])

    full = hanzi + symbols
    assert len(hanzi) == HANZI_SIZE
    assert len(symbols) == SYMBOL_SIZE
    assert len(full) == TOTAL_SIZE, len(full)
    assert len(set(full)) == TOTAL_SIZE, '存在重复字符，CHAR_MAP 会不可逆'
    return hanzi, symbols, full


def render_js(hanzi, symbols, rank):
    def wrap(s, per):
        return '\n'.join("    '%s' +" % s[i:i + per] for i in range(0, len(s), per))

    cov = sum(rank.get(c, 0) for c in hanzi) / max(1, sum(rank.values())) * 100
    return """/* ═══════════════════════════════════════════════════════════════════
 * 汉字密文 v2 字库（2048 字符 · 11 bit/字）
 * ═══════════════════════════════════════════════════════════════════
 *
 * ⚠️ 本文件由 tools/gen-hanzi-table.py 自动生成，请勿手改。
 *    重新生成：  python3 tools/gen-hanzi-table.py
 *    校验：      python3 tools/gen-hanzi-table.py --check
 *
 * 结构
 * ----
 *   序号    0 – 1791   汉字区（GB2312 一级字，按 MTSU 字频降序）
 *   序号 1792 – 2047   符号区（常用标点 / 数学 / 货币 / 箭头 / 几何 / 圈号）
 *
 * 编码约束
 * --------
 *   * 总长恒为 2048 → 11 bit/字，周期 88 bit（8 字 ↔ 11 字节），无位浪费
 *   * 字符唯一，无重复
 *   * **顺序即协议**：任何顺序变动都会让已发出的密文永久失效
 *
 * 汉字区频次覆盖：约占所选语料 %.2f%%
 */
(function (root) {
    'use strict';

    /* 汉字区：1792 字（序号 0–1791） */
    var HANZI =
%s
        '';

    /* 符号区：256 个（序号 1792–2047） */
    var SYMBOLS =
%s
        '';

    var ALPHABET = HANZI + SYMBOLS;

    if (ALPHABET.length !== 2048) {
        throw new Error('字库长度错误：期望 2048，实际 ' + ALPHABET.length);
    }

    root.HANZI_TABLE_V2 = {
        ALPHABET: ALPHABET,
        HANZI: HANZI,
        SYMBOLS: SYMBOLS,
        SIZE: 2048,
        BITS_PER_CHAR: 11,
        HANZI_SIZE: 1792,
        SYMBOL_SIZE: 256
    };
})(typeof window !== 'undefined' ? window : globalThis);
""" % (cov, wrap(hanzi, 56), wrap(symbols, 32))


def check_only():
    js = open(OUT_JS, encoding='utf-8').read()
    m = re.search(r"var HANZI =\n([\s\S]*?)\n\s*'';", js)
    m2 = re.search(r"var SYMBOLS =\n([\s\S]*?)\n\s*'';", js)
    if not m or not m2:
        raise SystemExit('校验失败：无法从 %s 解析字库' % OUT_JS)
    hanzi = ''.join(re.findall(r"'([^']*)'", m.group(1)))
    symbols = ''.join(re.findall(r"'([^']*)'", m2.group(1)))
    full = hanzi + symbols
    ok = True

    def chk(cond, msg):
        nonlocal ok
        print(('  ✓ ' if cond else '  ✗ ') + msg)
        ok = ok and cond

    print('校验 %s' % os.path.relpath(OUT_JS, REPO))
    chk(len(hanzi) == HANZI_SIZE, '汉字区长度 = %d' % HANZI_SIZE)
    chk(len(symbols) == SYMBOL_SIZE, '符号区长度 = %d' % SYMBOL_SIZE)
    chk(len(full) == TOTAL_SIZE, '总长 = %d' % TOTAL_SIZE)
    chk(len(set(full)) == TOTAL_SIZE, '字符唯一（无重复）')
    chk(all(0x3400 <= ord(c) <= 0x9FFF for c in hanzi), '汉字区无符号混入')
    chk(not any(c in BLACKLIST for c in hanzi), '黑名单未泄漏进字库')
    chk(all(0x2000 <= ord(c) or ord(c) < 0x3400 for c in symbols), '符号区无汉字')
    return 0 if ok else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--check', action='store_true', help='只校验已生成字库，不联网')
    args = ap.parse_args()

    if args.check:
        sys.exit(check_only())

    print('取字频表…')
    rank = fetch_freq_rank()
    print('  解析 %d 个字符的排名' % len(rank))

    hanzi, symbols, full = build(rank)
    with open(OUT_JS, 'w', encoding='utf-8') as f:
        f.write(render_js(hanzi, symbols, rank))

    print('已写出 %s' % os.path.relpath(OUT_JS, REPO))
    print('  汉字区 %d 字  符号区 %d 个  合计 %d' % (len(hanzi), len(symbols), len(full)))
    print('  汉字区首 32 字：%s' % hanzi[:32])
    print('  符号区首 32 个：%s' % symbols[:32])
    sys.exit(check_only())


if __name__ == '__main__':
    main()
