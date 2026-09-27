// PoW 工作线程：找满足前导零位数的 nonce
//
// ⚠️ Worker 里同样没有 crypto.subtle（非安全上下文），需要纯 JS 回退。
//    account.html 在局域网 http 下也会用到本 worker，
//    回退缺失会表现为「进度条一直不动」而不是明确报错。
self.onmessage = async (e) => {
    const { prefix, targetBits } = e.data;
    const enc = new TextEncoder();

    // 纯 JS 回退下逐条 await 2 万次会非常慢，故减小批并串行推进；
    // 原生路径保持原有 200 并行度。
    let native = !!(self.crypto && self.crypto.subtle);
    let softFn = null;
    if (!native) {
        try {
            const mod = await import('./vendor/cx-softcrypto.mjs');
            softFn = mod.sha256;
        } catch (err) {
            self.postMessage({ type: 'failed', reason: '无可用 SHA-256（原生与回退均不可用）: ' + err });
            return;
        }
    }

    const BATCH = native ? 200 : 500;

    for (let start = 0; start < 10_000_000; start += BATCH) {
        const hashes = [];
        if (native) {
            const arr = await Promise.all(
                Array.from({ length: BATCH }, (_, i) =>
                    crypto.subtle.digest('SHA-256', enc.encode(prefix + (start + i)))
                )
            );
            for (const h of arr) hashes.push(new Uint8Array(h));
        } else {
            for (let i = 0; i < BATCH; i++) {
                hashes.push(softFn(enc.encode(prefix + (start + i))));
            }
        }

        for (let i = 0; i < hashes.length; i++) {
            const hash = hashes[i];
            let zeros = 0;
            for (const byte of hash) {
                if (byte === 0) { zeros += 8; continue; }
                let mask = 0x80;
                while (!(byte & mask)) { zeros++; mask >>= 1; }
                break;
            }
            if (zeros >= targetBits) {
                self.postMessage({ type: 'done', nonce: start + i, attempts: start + i + 1, soft: !native });
                return;
            }
        }

        if (start % 10000 === 0) {
            self.postMessage({ type: 'progress', attempts: start + BATCH });
        }
    }

    self.postMessage({ type: 'failed' });
};
