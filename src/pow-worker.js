self.onmessage = async (e) => {
    const { prefix, targetBits } = e.data;
    const enc = new TextEncoder();
    const BATCH = 200;

    for (let start = 0; start < 10_000_000; start += BATCH) {
        const hashes = await Promise.all(
            Array.from({ length: BATCH }, (_, i) =>
                crypto.subtle.digest('SHA-256', enc.encode(prefix + (start + i)))
            )
        );

        for (let i = 0; i < hashes.length; i++) {
            const hash = new Uint8Array(hashes[i]);
            let zeros = 0;
            for (const byte of hash) {
                if (byte === 0) { zeros += 8; continue; }
                let mask = 0x80;
                while (!(byte & mask)) { zeros++; mask >>= 1; }
                break;
            }
            if (zeros >= targetBits) {
                self.postMessage({ type: 'done', nonce: start + i, attempts: start + i + 1 });
                return;
            }
        }

        if (start % 10000 === 0) {
            self.postMessage({ type: 'progress', attempts: start + BATCH });
        }
    }

    self.postMessage({ type: 'failed' });
};
