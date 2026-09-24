// CX2 引擎测试：HKDF + AES-256-GCM + P2 盲索引多接收方信封
//
// 覆盖：
//   ① 单播往返（N=1）
//   ② 一对多往返（N=3/N=5），每个接收方都能解出同一明文
//   ③ 负向：非接收方解不开（必须失败，不能静默出错值）
//   ④ 篡改检测：改密文任一字节 → 认证失败
//   ⑤ 长度：密文体 = 3 + 100N + 12 + 明文字节 + 16
//   ⑥ 头部解析：版本/收件人数
//
// 运行： node test/cx2.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

const ctx = vm.createContext({
    console, TextEncoder, TextDecoder, Map, Uint8Array, Array, Math, String, Error, btoa, atob, Promise,
    crypto: webcrypto,
    addEventListener() { },
    document: {
        addEventListener() { }, getElementById() { return null; },
        createElement() { return { style: {} }; },
        body: { appendChild() { }, removeChild() { } }
    },
    localStorage: { getItem() { return null; }, setItem() { } }
});
ctx.window = ctx;
ctx.globalThis = ctx;

// 按 <script> 顺序：字库 → core（提供 TA.M）→ cx2
for (const f of ['src/hanzi-table-v2.js', 'src/core.js']) {
    vm.runInContext(readFileSync(join(REPO, f), 'utf8'), ctx, { filename: f });
}
// core.js 里的 TA 在 text-crypto.html 内定义；这里注入仅含 X25519 的最小 TA
vm.runInContext(readFileSync(join(REPO, 'src', 'text-crypto.html'), 'utf8')
    .match(/const TA = \{[\s\S]*?\n\};/)[0].replace('const TA', 'var TA'), ctx, { filename: 'TA' });
vm.runInContext(readFileSync(join(REPO, 'src', 'cx2.js'), 'utf8'), ctx, { filename: 'cx2.js' });

const CX2 = vm.runInContext('CX2', ctx);
const TA = vm.runInContext('TA', ctx);

let pass = 0, fail = 0;
const t = (name, cond, extra = '') => {
    if (cond) { pass++; console.log('  PASS  ' + name + (extra ? '  :: ' + extra : '')); }
    else { fail++; console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')); }
};

// 造 N 个身份（仅用公钥/私钥对，不需要 PBKDF2）
const mkKeypair = () => {
    const sk = webcrypto.getRandomValues(new Uint8Array(32));
    return { sk, pk: TA.M.m(sk, null) };
};
const b64 = buf => Buffer.from(new Uint8Array(buf)).toString('base64');

const A = mkKeypair(), B = mkKeypair(), C = mkKeypair(), D = mkKeypair();
const MSG = '这是一条端到端加密的测试消息 🔐 with ascii';

console.log('① 单播往返 (N=1)');
{
    const ct = await CX2.encrypt(MSG, [b64(A.pk)]);
    const pt = await CX2.decrypt(ct, A.sk);
    t('A 能解出', pt === MSG, JSON.stringify(pt.slice(0, 20)) + '…');
    t('头部声明 1 个收件人', CX2.inspect(ct).recipients === 1);
    t('版本 = 2', CX2.inspect(ct).version === 2);
}

console.log('\n② 一对多往返 (N=3, N=5)');
{
    const peers3 = [A, B, C].map(x => b64(x.pk));
    const ct3 = await CX2.encrypt(MSG, peers3);
    for (const [nm, k] of [['A', A], ['B', B], ['C', C]]) {
        const pt = await CX2.decrypt(ct3, k.sk);
        t(`N=3 收件人 ${nm} 能解出`, pt === MSG);
    }
    t('N=3 声明 3 个收件人', CX2.inspect(ct3).recipients === 3);

    const peers5 = [A, B, C, D, mkKeypair()].map(x => b64(x.pk));
    const ct5 = await CX2.encrypt(MSG, peers5);
    const okAll = [];
    for (const k of [A, B, C, D]) okAll.push(await CX2.decrypt(ct5, k.sk) === MSG);
    t('N=5 四位收件人全部解出', okAll.every(Boolean));
}

console.log('\n③ 负向：非接收方解不开');
{
    const outsider = mkKeypair();
    const ct = await CX2.encrypt(MSG, [b64(A.pk)]);
    let err = null;
    try { await CX2.decrypt(ct, outsider.sk); } catch (e) { err = e.message; }
    t('局外人被拒绝', err !== null, err || '竟然解开了！');

    // 群发里不在名单上的人同样解不开
    const ct3 = await CX2.encrypt(MSG, [A, B, C].map(x => b64(x.pk)));
    let err2 = null;
    try { await CX2.decrypt(ct3, outsider.sk); } catch (e) { err2 = e.message; }
    t('群发中非名单成员被拒绝', err2 !== null, err2 || '竟然解开了！');
}

console.log('\n④ 篡改检测');
{
    const ct = await CX2.encrypt(MSG, [b64(A.pk)]);
    const raw = Buffer.from(ct, 'base64');
    // 改正文区任一字节
    const tamperedBody = Buffer.from(raw); tamperedBody[tamperedBody.length - 5] ^= 0xff;
    let e1 = null;
    try { await CX2.decrypt(tamperedBody.toString('base64'), A.sk); } catch (e) { e1 = e.message; }
    t('正文被篡改 → 报错', e1 !== null, e1 || '未检出！');

    // 改包裹区
    const tamperedWrap = Buffer.from(raw); tamperedWrap[60] ^= 0xff;
    let e2 = null;
    try { await CX2.decrypt(tamperedWrap.toString('base64'), A.sk); } catch (e) { e2 = e.message; }
    t('包裹被篡改 → 报错', e2 !== null, e2 || '未检出！');

    // 截断
    const truncated = raw.subarray(0, raw.length - 20).toString('base64');
    let e3 = null;
    try { await CX2.decrypt(truncated, A.sk); } catch (e) { e3 = e.message; }
    t('截断 → 报错', e3 !== null, e3 || '未检出！');
}

console.log('\n⑤ 长度公式');
{
    for (const [n, plen] of [[1, 20], [3, 20], [1, 200], [5, 1000]]) {
        const peers = Array.from({ length: n }, () => mkKeypair()).map(x => b64(x.pk));
        const msg = 'x'.repeat(plen);
        const ct = await CX2.encrypt(msg, peers);
        const bodyBytes = Buffer.from(ct, 'base64').length;
        const want = 3 + 100 * n + 12 + Buffer.byteLength(msg, 'utf8') + 16;
        t(`N=${n} 明文${plen}B`, bodyBytes === want, `实际 ${bodyBytes} / 期望 ${want}`);
    }
}

console.log('\n⑥ 中文与 emoji 保真');
{
    const tricky = '汉字+emoji🎉+符号★☆+换行\n第二行\ttab';
    const ct = await CX2.encrypt(tricky, [b64(A.pk), b64(B.pk)]);
    t('A 解出一致', await CX2.decrypt(ct, A.sk) === tricky);
    t('B 解出一致', await CX2.decrypt(ct, B.sk) === tricky);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
