/* 关键回归：放行集内不得有任何会被解码端剥离的字符（否则静默 DESYNC）
 * 用真模型跑多帧，逐帧验证「段体字节数 == 剥离后字节数」。 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReal, createEngine, encodeAll, decodeAll } from './stego-real.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { M, V } = loadReal(join(REPO, '.pcd', 'pcd-v3-6M-fixedpoint', 'model'));
const engine = createEngine(M);
const STRIP = /[\s\u200b-\u200d\ufeff]/g;

let pass = 0, fail = 0; const failures = [];
const ok = (c, n, x = '') => { if (c) pass++; else { fail++; failures.push(n + (x ? '  :: ' + x : '')); } };

console.log('放行集无剥离字符验证（多帧真模型）\n');

for (const [label, n] of [['1 帧', 100], ['3 帧', 400]]) {
    const payload = new Uint8Array(n);
    for (let i = 0; i < n; i++) payload[i] = (i * 31 + 7) & 0xff;
    const r = await encodeAll(payload, { engine, V, msgid: 'ns' + n });
    let bad = 0, totalChars = 0;
    for (const s of r.segments) {
        const before = s.body.length;
        const after = s.body.replace(STRIP, '').length;
        totalChars += before;
        if (before !== after) bad++;
    }
    ok(bad === 0, `${label} 段体剥离前后长度一致（无静默损坏）`, bad + ' 段被改动');
    // 往返
    const wire = r.segments.map(s => `CX2|${s.seq}/${s.total}|${s.msgid}|${s.total}:${s.seq}|${s.body}`).join('\n\n');
    const d = await decodeAll(wire, { engine, V });
    const same = Buffer.compare(Buffer.from(d.bytes), Buffer.from(payload)) === 0;
    ok(same, `${label} 往返字节一致`);
    console.log(`  ${label}: ${r.segments.length} 段 · ${totalChars} 字 · 往返 ${same ? '✓' : '★'}`);
}

console.log('\n' + '═'.repeat(60));
if (fail === 0) console.log(`✅ 全通：${pass} 项断言`);
else { console.log(`❌ ${fail} 项失败`); failures.forEach(f => console.log('   ✗ ' + f)); }
console.log('═'.repeat(60));
process.exit(fail === 0 ? 0 : 1);
