// 汉字密文 v2 编解码单元测试（Node 直跑，无需浏览器）
//
// 覆盖：
//   ① 字库完整性（长度 2048 / 唯一 / 11bit 周期）
//   ② 编解码往返无损（多长度）
//   ③ 输出长度符合 ceil(n*8/11)
//   ④ isHanzi 判定：真密文命中、Base64 不误判、自然中文不误判
//   ⑤ 旧 4096 字库密文**应解不开**（不向下兼容是设计目标，须显式断言）
//
// 运行： node test/hanzi-v2.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

// 构造最小浏览器环境，把两个脚本按 <script> 顺序灌进同一个 vm 上下文
const ctx = vm.createContext({
    console,
    addEventListener() { },
    document: {
        addEventListener() { }, getElementById() { return null; },
        createElement() { return { style: {} }; },
        body: { appendChild() { }, removeChild() { } }
    },
    localStorage: { getItem() { return null; }, setItem() { } },
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    TextEncoder, TextDecoder, Map, Uint8Array, Array, Math, String, Error
});
ctx.window = ctx;
ctx.globalThis = ctx;

for (const f of ['src/hanzi-table-v2.js', 'src/core.js']) {
    vm.runInContext(readFileSync(join(REPO, f), 'utf8'), ctx, { filename: f });
}
const H = vm.runInContext('HanziCodec', ctx);

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  :: ' + extra : '')); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')); }
};

console.log('① 字库完整性');
t('长度 = 2048', H.ALPHABET.length === 2048, String(H.ALPHABET.length));
t('字符唯一', new Set(H.ALPHABET).size === 2048);
t('BITS = 11', H.BITS === 11);
t('周期 88bit 整除 8bit', (8 * 11) % 8 === 0, '8字=11字节');

console.log('\n② 编解码往返');
// 严格等长断言：解码结果必须与原字节**完全相同**。
// 旧断言只查前缀（src.every(...)），会漏掉「多出尾字节」的缺陷 ——
// 那正是 27.3% 长度导致解密失败、报成「认证失败」的真因。
for (const n of [1, 2, 3, 4, 5, 7, 8, 10, 11, 14, 16, 18, 21, 32, 64, 128, 512, 1000, 2048]) {
    const src = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 91) % 256));
    const enc = H.encode(src);
    const dec = H.decode(enc);
    t(`n=${n} 往返严格一致`, dec.length === n && src.every((v, i) => v === dec[i]),
        `${enc.length} 字 -> ${dec.length} 字节`);
}

// 穷举 1..3000：任何长度都不得出现「解码字节数 != 原长」
{
    let mismatch = [];
    for (let n = 1; n <= 3000; n++) {
        const src = new Uint8Array(Array.from({ length: n }, (_, i) => (i * 37 + 91) % 256));
        const dec = H.decode(H.encode(src));
        if (dec.length !== n || !src.every((v, i) => v === dec[i])) mismatch.push(n);
    }
    t('长度 1..3000 全部精确往返', mismatch.length === 0,
        mismatch.length ? '失败长度: ' + mismatch.slice(0, 10).join(',') + '…（共 ' + mismatch.length + ' 个）' : '0 个失配');
}

console.log('\n③ 输出长度 = ceil((5+n)*8/11)   // 5 = 1 字节标志 + 4 字节长度头');
for (const n of [1, 8, 11, 22, 100, 1000]) {
    const enc = H.encode(new Uint8Array(n));
    const want = Math.ceil((5 + n) * 8 / 11);
    t(`n=${n}`, enc.length === want, `实际 ${enc.length} / 期望 ${want}`);
}
// 长度头的固定开销（字符数），用于对外说明密文膨胀
{
    const over = [1, 10, 100, 1000].map(n => H.encode(new Uint8Array(n)).length - Math.ceil(n * 8 / 11));
    t('长度头开销恒定（约 4 字）', over.every(v => Math.abs(v - over[0]) <= 1), '开销 ' + JSON.stringify(over));
}

console.log('\n④ isHanzi 判定');
const real = H.encode(new Uint8Array(Array.from({ length: 60 }, (_, i) => (i * 13 + 7) % 256)));
t('真密文 → 命中', H.isHanzi(real) === true, real.slice(0, 12) + '…');
t('短于 8 字 → 不判定', H.isHanzi('之一不') === false);
t('Base64 → 不误判', H.isHanzi('SGVsbG8gd29ybGQsIHRoaXMgaXMgYSB0ZXN0') === false);
t('含 +/= 的 Base64 → 不误判', H.isHanzi('abc+/def==') === false);
t('自然中文长句 → 不误判',
    H.isHanzi('今天天气不错我们去公园散步吧顺便买点水果回来吃') === false,
    '含大量字库外字');

console.log('\n⑤ 旧 4096 字库密文应解不开（不兼容是设计目标）');
// 旧版首个字符是「啊」(旧表 idx 0)，新表 idx 0 是「之」
// 取一段旧版风格密文（用旧表字符），新表解码应抛错或产出无意义字节
const oldStyle = '啊阿埃挨哎唉哀皑癌蔼矮艾碍';   // 旧 4096 表前 16 字
let threw = false, decoded = null;
try { decoded = H.decode(oldStyle); } catch (e) { threw = true; }
t('旧字库密文被拒绝（抛错）', threw === true,
    threw ? '已抛错' : `未抛错，产出 ${decoded && decoded.length} 字节（含字库外字判错）`);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
