/* ═══════════════════════════════════════════════════════════════════
 * 真资产审计：vocab.bin 字节级校验 + golden 对齐 + 白名单可行性
 * ═══════════════════════════════════════════════════════════════════
 *
 * 目的：在把候选管线切到真词表之前，先用**实测数据**回答三件事：
 *   ① README §6 声称有 456 个非法 UTF-8 token —— 是否属实？
 *   ② 词表里有多少 token 含空白/控制字节（必须被白名单拒掉）？
 *   ③ 在真 top-256 上，各种白名单策略能否凑满 64 个候选？（凑不满就得降 K 或放宽）
 *   ④ 真词表的加权 avg_token_bytes 是多少？（决定 10x 膨胀线）
 *
 * 运行： node test/stego/vocab-audit.mjs
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PCD = join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint');
const M = join(PCD, 'model');

const fmt = JSON.parse(readFileSync(join(M, 'format.json'), 'utf8'));
const vb = readFileSync(join(M, 'vocab.bin'));
const N = fmt.vocab.vocab_size;
const STREAM_BYTES = fmt.vocab.stream_bytes;
const INDEX_BYTES = fmt.vocab.index_bytes;

console.log('═══ 真资产审计 pcd-v3-6M ═══\n');
console.log(`vocab: size=${N} index=${INDEX_BYTES}B stream=${STREAM_BYTES}B 合计=${INDEX_BYTES + STREAM_BYTES}B（实际 ${vb.length}B）`);

/* ── 按字节切 token（绝不对单 token 做字符串解码） ── */
const offs = new Uint16Array(N);
for (let i = 0; i < N; i++) offs[i] = vb.readUInt16LE(i * 2);
const stream = vb.subarray(INDEX_BYTES);
const toks = [];
for (let i = 0; i < N; i++) {
    const a = offs[i], b = (i + 1 < N) ? offs[i + 1] : STREAM_BYTES;
    toks.push(stream.subarray(a, b));
}

/* ═══ ① 非法局部 UTF-8 审计 ═══ */
console.log('\n① 局部 UTF-8（BPE 切半）审计');
const fatal = new TextDecoder('utf-8', { fatal: true });
const loose = new TextDecoder('utf-8', { fatal: false });
let fatalFail = 0, fffdTok = 0;
const fatalIds = [], fffdIds = [];
for (let i = 0; i < N; i++) {
    let ok = true;
    try { fatal.decode(toks[i]); } catch { ok = false; }
    if (!ok) { fatalFail++; if (fatalIds.length < 10) fatalIds.push(i); }
    if (loose.decode(toks[i]).includes('\ufffd')) { fffdTok++; if (fffdIds.length < 10) fffdIds.push(i); }
}
console.log(`  fatal 解码抛错的 token : ${fatalFail}  ${fatalIds.length ? '样例 ' + fatalIds.join(',') : ''}`);
console.log(`  宽松解码含 U+FFFD 的 token: ${fffdTok}  ${fffdIds.length ? '样例 ' + fffdIds.join(',') : ''}`);
console.log(`  README §6 声称         : 456`);
console.log(`  → 实测结论: ${fffdTok === 0 ? '★ 词表中**不存在**非法局部 UTF-8 token（README 声称的 456 与资产不符）'
    : fffdTok === 456 ? '与 README 一致' : `与 README 不一致（实测 ${fffdTok}）`}`);

/* ═══ ② 控制/空白字节审计 ═══ */
console.log('\n② 控制/空白字节审计（必须被白名单拒掉）');
let nlTok = [], wsTok = [], ctrlTok = [];
for (let i = 0; i < N; i++) {
    const t = toks[i];
    if ([...t].some(b => b === 0x0A || b === 0x0D)) nlTok.push(i);
    if ([...t].some(b => b === 0x20 || b === 0x09)) wsTok.push(i);
    if ([...t].some(b => b < 0x20 && b !== 0x09 && b !== 0x0A && b !== 0x0D)) ctrlTok.push(i);
}
console.log(`  含 \\n 或 \\r : ${nlTok.length}  ${nlTok.join(',')}`);
console.log(`  含 空格/制表 : ${wsTok.length}  ${wsTok.join(',')}`);
console.log(`  含其他控制字节: ${ctrlTok.length}  ${ctrlTok.slice(0, 20).join(',')}`);

/* ═══ ③ golden 对齐：验证排序规则能复现 top64 ═══ */
console.log('\n③ golden 对齐（验证 排序规则 = 分数降序 / token_id 升序决胜）');
const gj = JSON.parse(readFileSync(join(PCD, 'golden', 'golden.json'), 'utf8'));
const gb = readFileSync(join(PCD, 'golden', 'golden.bin'));
const i32 = new Int32Array(gb.buffer, gb.byteOffset, gb.byteLength / 4);

function topK(logits, k) {
    const idx = Array.from({ length: logits.length }, (_, i) => i);
    idx.sort((a, b) => (logits[b] - logits[a]) || (a - b));
    return idx.slice(0, k);
}
let sortOk = 0;
for (let gi = 0; gi < gj.n_groups; gi++) {
    const grp = gj.groups[gi];
    const logits = i32.subarray(gi * 4096, (gi + 1) * 4096);
    const mine = topK(logits, 64);
    const theirs = grp.top64.map(e => e.token_id);
    const same = mine.every((v, i) => v === theirs[i]);
    const scoreOk = grp.top64.every((e, i) => logits[e.token_id] === e.score_i32);
    if (same && scoreOk) sortOk++;
    console.log(`  ${grp.id}: top64 ${same ? '完全一致 ✓' : '★不一致'}  score_i32 ${scoreOk ? '一致 ✓' : '★不一致'}`);
    if (!same) {
        const diff = mine.findIndex((v, i) => v !== theirs[i]);
        console.log(`     首个分歧 rank ${diff + 1}: 本实现 ${mine[diff]} vs golden ${theirs[diff]}`);
    }
}
console.log(`  → ${sortOk}/${gj.n_groups} 组排序规则复现成功`);

/* ═══ ④ 白名单策略可行性（真 top-256 上） ═══ */
console.log('\n④ 白名单策略可行性（top-256 → 需凑满 64）');
const isCJK = b => { const c = b.codePointAt(0); return c >= 0x4E00 && c <= 0x9FFF; };
const CN_PUNCT = '，。！？、；：（）《》“”‘’…—·';
const FAIL = '�';

function classify(t) {
    // 字节级：先看是否纯 ASCII，再判断是否合法完整 UTF-8
    const allAscii = [...t].every(b => b < 0x80);
    let s = null, valid = true;
    try { s = fatal.decode(t); } catch { valid = false; }
    // 控制/空白
    const bad = [...t].some(b => b < 0x20) || [...t].some(b => b === 0x20 || b === 0x09);
    return { allAscii, s, valid, bad };
}
const policies = {
    'P1 纯汉字': (t, c) => c.valid && [...c.s].every(ch => isCJK(ch)),
    'P2 汉字+中文标点': (t, c) => c.valid && [...c.s].every(ch => isCJK(ch) || CN_PUNCT.includes(ch)),
    'P3 P2+ASCII字母数字': (t, c) => c.valid && !c.bad && [...c.s].every(ch => isCJK(ch) || CN_PUNCT.includes(ch) || /[A-Za-z0-9]/.test(ch)),
    'P4 任意无空白合法UTF-8': (t, c) => c.valid && !c.bad,
};
const policyStats = {};
for (const name of Object.keys(policies)) policyStats[name] = [];

for (let gi = 0; gi < gj.n_groups; gi++) {
    const grp = gj.groups[gi];
    const logits = i32.subarray(gi * 4096, (gi + 1) * 4096);
    const raw = topK(logits, 256);
    const cls = raw.map(id => classify(toks[id]));
    const line = [];
    for (const [name, fn] of Object.entries(policies)) {
        let pass = 0;
        for (let k = 0; k < raw.length && pass < 64; k++) if (fn(toks[raw[k]], cls[k])) pass++;
        line.push(`${name}=${pass}`);
        policyStats[name].push(pass);
    }
    console.log(`  ${grp.id.padEnd(14)} ${line.join('  ')}`);
}
console.log('\n  各策略能否稳定凑满 64：');
for (const [name, arr] of Object.entries(policyStats)) {
    const min = Math.min(...arr);
    console.log(`    ${name.padEnd(24)} 最少 ${min} ${min >= 64 ? '✓ 可凑满' : '★ 凑不满（需降 K 或放宽策略）'}`);
}

/* ═══ ⑤ 真词表膨胀率 ═══ */
console.log('\n⑤ 真词表膨胀率（64 名等概率假设）');
let sum = 0, cnt = 0, maxB = 0;
const lenAcc = {};
for (let gi = 0; gi < gj.n_groups; gi++) {
    for (const e of gj.groups[gi].top64) {
        const L = toks[e.token_id].length;
        sum += L; cnt++; maxB = Math.max(maxB, L);
        lenAcc[L] = (lenAcc[L] || 0) + 1;
    }
}
const avg = sum / cnt;
const ratioPayload = (8 * avg) / 6;
console.log(`  top-64 平均 token 字节 = ${avg.toFixed(2)} B（最大 ${maxB} B，样本 ${cnt}）`);
console.log(`  长度分布: ${JSON.stringify(lenAcc)}`);
console.log(`  对载荷膨胀 = 8×${avg.toFixed(2)}/6 = ${ratioPayload.toFixed(2)}x`);
console.log(`  判定线 avg ≤ 7.5 → ${avg <= 7.5 ? '✓ 守住 10x' : '★ 超过，需与模型端协商词表长度分布'}`);
for (const P of [200, 500, 1000, 2000, 3000]) {
    const cx = P + 131;
    const frames = Math.ceil(cx / 188);
    const chars = frames * 256;
    const outBytes = chars * avg;
    console.log(`    明文 ${String(P).padStart(4)}B → ${frames} 帧 → 约 ${chars} token → 伪装文本 ${(outBytes / 1024).toFixed(1)} KB → 膨胀 ${(outBytes / P).toFixed(2)}x`);
}
