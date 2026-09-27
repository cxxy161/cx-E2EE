/* ═══════════════════════════════════════════════════════════════════
 * 纯 JS 密码学回退实现（cx-softcrypto）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 用途
 * ----
 *   非安全上下文（如手机经局域网 http://192.168.x.x 访问）下
 *   `window.crypto` 存在、`getRandomValues` 可用，但 **`crypto.subtle` 是 undefined**。
 *   此时本模块提供与 WebCrypto **逐字节一致**的原语，使加密链路继续可用。
 *
 * ⚠️ 安全边界（必须让使用者知道）
 * ------------------------------
 *   本模块只解决「能不能算」，**不能**把 http 变成安全信道：
 *   页面脚本本身可被中间人篡改，能改 JS 就能偷口令。
 *   因此调用方**必须**在 soft 模式下展示常驻警告条。
 *
 * ⚠️ 为什么不能换成 ChaCha20/secretbox
 * -----------------------------------
 *   src/vendor/nacl-fast.min.js 里有现成的 secretbox，但它是 XSalsa20-Poly1305，
 *   与 AES-GCM **线格式不兼容**：http 下发出的包，对方在 https 下解不开。
 *   回退实现必须与原生完全一致（同 key/iv/plain → 同 ciphertext‖tag），
 *   故只能实现 AES-GCM + SHA-256 系列。
 *
 * 导出
 * ----
 *   sha256(bytes)                        → Uint8Array(32)
 *   hmacSha256(key, msg)                 → Uint8Array(32)
 *   hkdf(ikm, salt, info, len)           → Uint8Array(len)
 *   pbkdf2(pw, salt, iterations, len)    → Uint8Array(len)
 *   gcmSeal(key, iv, plain)              → Uint8Array(ct ‖ tag)   同 WebCrypto encrypt
 *   gcmOpen(key, iv, cipher)             → Uint8Array(plain)      认证失败抛 Error
 *   aesEncryptBlock(key, block)          → Uint8Array(16)         仅供测试/调试
 *
 * 所有长度参数均为**字节**。
 * ═══════════════════════════════════════════════════════════════════ */

'use strict';

/* ───────────────────────────────────────────────────────────────
 * 0. 小工具
 * ─────────────────────────────────────────────────────────────── */

const u8 = (x) => (x instanceof Uint8Array ? x : new Uint8Array(x));

/** 拼接若干 Uint8Array */
function concat(...parts) {
    let n = 0;
    for (const p of parts) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
}

/** 等长比较，恒定时间（避免 tag 校验的时序侧信道） */
function timingSafeEqual(a, b) {
    if (a.length !== b.length) return false;
    let d = 0;
    for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
    return d === 0;
}

/**
 * 真正的**拷贝**。
 *
 * ⚠️ 不能用 `.slice()`：Node 的 `Buffer` 是 Uint8Array 子类且**覆写了 slice()**
 *    使其返回同内存视图（非拷贝）。而本模块的 `u8()` 对 Buffer 入参是原样返回的，
 *    于是 `Buffer.prototype.slice` 会被继承进来 —— 表现为轮函数里的临时数组
 *    被就地写坏（ShiftRows 读到自己的写入），AES 全盘出错。
 *    浏览器里是真正的 Uint8Array（slice 即拷贝），但同构测试会踩到，故统一用本函数。
 */
function copyBytes(x) {
    const src = x instanceof Uint8Array ? x : new Uint8Array(x);
    const out = new Uint8Array(src.length);
    out.set(src);
    return out;
}

/* ───────────────────────────────────────────────────────────────
 * 1. SHA-256
 * ─────────────────────────────────────────────────────────────── */

const SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

/**
 * SHA-256。
 * @param {Uint8Array} bytes
 * @returns {Uint8Array} 32 字节摘要
 */
export function sha256(bytes) {
    const msg = u8(bytes);
    const len = msg.length;
    // 填充：0x80 + 0x00… + 64bit 大端比特长度
    const bitLen = len * 8;
    const padLen = ((len + 9 + 63) >> 6) << 6;      // 补到 64 字节整数倍
    const buf = new Uint8Array(padLen);
    buf.set(msg);
    buf[len] = 0x80;
    // 比特长度写入最后 8 字节（大端）。> 2^32 bit 不支持（本场景不会出现）
    const dv = new DataView(buf.buffer);
    dv.setUint32(padLen - 8, Math.floor(bitLen / 0x100000000));
    dv.setUint32(padLen - 4, bitLen >>> 0);

    const H = new Uint32Array([
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    const w = new Uint32Array(64);

    for (let off = 0; off < padLen; off += 64) {
        for (let i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4);
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15], b = w[i - 2];
            const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let a = H[0], b = H[1], c = H[2], d = H[3],
            e = H[4], f = H[5], g = H[6], h = H[7];

        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;

            h = g; g = f; f = e; e = (d + t1) >>> 0;
            d = c; c = b; b = a; a = (t1 + t2) >>> 0;
        }

        H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0;
        H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0;
        H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0;
        H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0;
    }

    const out = new Uint8Array(32);
    const odv = new DataView(out.buffer);
    for (let i = 0; i < 8; i++) odv.setUint32(i * 4, H[i]);
    return out;
}

/* ───────────────────────────────────────────────────────────────
 * 2. HMAC-SHA256
 * ─────────────────────────────────────────────────────────────── */

const SHA256_BLOCK = 64;

/**
 * HMAC-SHA256。
 * @param {Uint8Array} key
 * @param {Uint8Array} msg
 * @returns {Uint8Array} 32 字节
 */
export function hmacSha256(key, msg) {
    let k = u8(key);
    if (k.length > SHA256_BLOCK) k = sha256(k);
    const pad = new Uint8Array(SHA256_BLOCK);
    pad.set(k);

    const ipad = new Uint8Array(SHA256_BLOCK);
    const opad = new Uint8Array(SHA256_BLOCK);
    for (let i = 0; i < SHA256_BLOCK; i++) {
        ipad[i] = pad[i] ^ 0x36;
        opad[i] = pad[i] ^ 0x5c;
    }
    return sha256(concat(opad, sha256(concat(ipad, u8(msg)))));
}

/* ───────────────────────────────────────────────────────────────
 * 3. HKDF-SHA256
 * ─────────────────────────────────────────────────────────────── */

/**
 * HKDF-SHA256（RFC 5869）。语义与 WebCrypto deriveBits({name:'HKDF'}) 一致。
 * @param {Uint8Array} ikm   输入密钥材料
 * @param {Uint8Array} salt  盐（长度 0 时按 RFC 用全零）
 * @param {Uint8Array} info  上下文/域分隔
 * @param {number}     len   输出字节数（上限 255*32）
 * @returns {Uint8Array}
 */
export function hkdf(ikm, salt, info, len) {
    const ikmB = u8(ikm), saltB = u8(salt), infoB = u8(info);
    if (len <= 0 || len > 255 * 32) throw new Error('hkdf: 输出长度非法');

    // Extract
    const prk = hmacSha256(saltB.length ? saltB : new Uint8Array(32), ikmB);

    // Expand
    const out = new Uint8Array(len);
    let prev = new Uint8Array(0);
    let o = 0, counter = 1;
    while (o < len) {
        prev = hmacSha256(prk, concat(prev, infoB, new Uint8Array([counter])));
        const take = Math.min(32, len - o);
        out.set(prev.subarray(0, take), o);
        o += take;
        counter++;
    }
    return out;
}

/* ───────────────────────────────────────────────────────────────
 * 4. PBKDF2-HMAC-SHA256
 * ─────────────────────────────────────────────────────────────── */

/**
 * PBKDF2-HMAC-SHA256。语义与 WebCrypto deriveBits({name:'PBKDF2'}) 一致。
 * @param {Uint8Array} pw          口令字节
 * @param {Uint8Array} salt        盐
 * @param {number}     iterations  迭代次数
 * @param {number}     len         输出字节数
 * @returns {Uint8Array}
 */
export function pbkdf2(pw, salt, iterations, len) {
    const pwB = u8(pw), saltB = u8(salt);
    if (!iterations || iterations < 1) throw new Error('pbkdf2: 迭代次数非法');
    if (len <= 0) throw new Error('pbkdf2: 输出长度非法');

    const hLen = 32;
    const blocks = Math.ceil(len / hLen);
    const out = new Uint8Array(blocks * hLen);
    const ctr = new Uint8Array(4);

    for (let i = 1; i <= blocks; i++) {
        // U1 = PRF(P, S ‖ INT(i))
        ctr[0] = (i >>> 24) & 0xff; ctr[1] = (i >>> 16) & 0xff;
        ctr[2] = (i >>> 8) & 0xff; ctr[3] = i & 0xff;

        let u = hmacSha256(pwB, concat(saltB, ctr));
        const acc = copyBytes(u);
        for (let j = 1; j < iterations; j++) {
            u = hmacSha256(pwB, u);
            for (let k = 0; k < hLen; k++) acc[k] ^= u[k];
        }
        out.set(acc, (i - 1) * hLen);
    }
    return out.subarray(0, len);
}

/* ───────────────────────────────────────────────────────────────
 * 5. AES-256（分组加密；GCM 只用正方向）
 * ─────────────────────────────────────────────────────────────── */

/* GF(2^8) 乘法，模 x^8+x^4+x^3+x+1 (0x11b) */
function gmul(a, b) {
    let p = 0;
    for (let i = 0; i < 8; i++) {
        if (b & 1) p ^= a;
        const hi = a & 0x80;
        a = (a << 1) & 0xff;
        if (hi) a ^= 0x1b;
        b >>= 1;
    }
    return p & 0xff;
}
function gpow(a, n) {
    let r = 1;
    while (n > 0) {
        if (n & 1) r = gmul(r, a);
        a = gmul(a, a);
        n >>= 1;
    }
    return r;
}
const rotl8 = (x, n) => ((x << n) | (x >>> (8 - n))) & 0xff;

/* S-box 程序化生成（比手抄 256 个常量更不易出错）：
 * S[a] = inv(a) ⊕ rotl(inv,1) ⊕ rotl(inv,2) ⊕ rotl(inv,3) ⊕ rotl(inv,4) ⊕ 0x63 */
const SBOX = new Uint8Array(256);
for (let i = 0; i < 256; i++) {
    const inv = i === 0 ? 0 : gpow(i, 254);
    SBOX[i] = (inv ^ rotl8(inv, 1) ^ rotl8(inv, 2) ^ rotl8(inv, 3) ^ rotl8(inv, 4) ^ 0x63) & 0xff;
}

/**
 * AES 密钥扩展。支持 16/24/32 字节密钥（AES-128/192/256）。
 * @returns {{rk: Uint8Array, Nr: number}} rk 为 (Nr+1)*16 字节的轮密钥
 */
function aesExpandKey(key) {
    const Nk = key.length / 4;
    if (Nk !== 4 && Nk !== 6 && Nk !== 8) throw new Error('AES: 密钥长度必须是 16/24/32 字节');
    const Nr = Nk + 6;
    const total = 4 * (Nr + 1);
    const w = new Uint32Array(total);

    for (let i = 0; i < Nk; i++) {
        w[i] = ((key[4 * i] << 24) | (key[4 * i + 1] << 16) | (key[4 * i + 2] << 8) | key[4 * i + 3]) >>> 0;
    }
    let rcon = 1;
    for (let i = Nk; i < total; i++) {
        let t = w[i - 1];
        if (i % Nk === 0) {
            t = ((t << 8) | (t >>> 24)) >>> 0;                       // RotWord
            t = ((SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) |
                 (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;  // SubWord
            t = (t ^ (rcon << 24)) >>> 0;
            rcon = gmul(rcon, 2);
        } else if (Nk > 6 && i % Nk === 4) {
            t = ((SBOX[(t >>> 24) & 0xff] << 24) | (SBOX[(t >>> 16) & 0xff] << 16) |
                 (SBOX[(t >>> 8) & 0xff] << 8) | SBOX[t & 0xff]) >>> 0;
        }
        w[i] = (w[i - Nk] ^ t) >>> 0;
    }

    // 展开成字节形式，便于按列做 MixColumns
    const rk = new Uint8Array(total * 4);
    for (let i = 0; i < total; i++) {
        rk[4 * i] = (w[i] >>> 24) & 0xff;
        rk[4 * i + 1] = (w[i] >>> 16) & 0xff;
        rk[4 * i + 2] = (w[i] >>> 8) & 0xff;
        rk[4 * i + 3] = w[i] & 0xff;
    }
    return { rk, Nr };
}

/* 状态按列主序：s[r + 4c]，输入字节序 b0..b15 → s[0..15] 直接对应 */
function subBytes(s) { for (let i = 0; i < 16; i++) s[i] = SBOX[s[i]]; }

function shiftRows(s) {
    const t = copyBytes(s);
    for (let r = 1; r < 4; r++) {
        for (let c = 0; c < 4; c++) {
            s[r + 4 * c] = t[r + 4 * ((c + r) % 4)];
        }
    }
}

function mixColumns(s) {
    for (let c = 0; c < 4; c++) {
        const i = 4 * c;
        const a0 = s[i], a1 = s[i + 1], a2 = s[i + 2], a3 = s[i + 3];
        s[i]     = gmul(a0, 2) ^ gmul(a1, 3) ^ a2 ^ a3;
        s[i + 1] = a0 ^ gmul(a1, 2) ^ gmul(a2, 3) ^ a3;
        s[i + 2] = a0 ^ a1 ^ gmul(a2, 2) ^ gmul(a3, 3);
        s[i + 3] = gmul(a0, 3) ^ a1 ^ a2 ^ gmul(a3, 2);
    }
}

function addRoundKey(s, rk, round) {
    const off = round * 16;
    for (let i = 0; i < 16; i++) s[i] ^= rk[off + i];
}

/**
 * AES 单分组加密（仅供测试与 GCM 内部使用）。
 * @param {Uint8Array} key   16/24/32 字节
 * @param {Uint8Array} block 16 字节
 * @returns {Uint8Array} 16 字节
 */
export function aesEncryptBlock(key, block) {
    const { rk, Nr } = aesExpandKey(u8(key));
    const s = copyBytes(u8(block)).subarray(0, 16);
    addRoundKey(s, rk, 0);
    for (let r = 1; r < Nr; r++) {
        subBytes(s); shiftRows(s); mixColumns(s); addRoundKey(s, rk, r);
    }
    subBytes(s); shiftRows(s); addRoundKey(s, rk, Nr);
    return s;
}

/* ───────────────────────────────────────────────────────────────
 * 6. AES-GCM
 * ─────────────────────────────────────────────────────────────── */

/** GF(2^128) 乘法，按 GCM 规范（位反射序）。x、h 均为 16 字节。 */
function gf128Mul(x, h) {
    const z = new Uint8Array(16);
    const v = copyBytes(h);
    for (let i = 0; i < 128; i++) {
        // 取 x 的第 i 位（MSB 优先）
        if ((x[i >> 3] >> (7 - (i & 7))) & 1) {
            for (let j = 0; j < 16; j++) z[j] ^= v[j];
        }
        // v >>= 1，若最低位为 0 则v >> 1，否则 v = (v >> 1) ^ R，R = 0xe1 ‖ 0^120
        const lsb = v[15] & 1;
        for (let j = 15; j > 0; j--) v[j] = ((v[j] >>> 1) | (v[j - 1] << 7)) & 0xff;
        v[0] = v[0] >>> 1;
        if (lsb) v[0] ^= 0xe1;
    }
    return z;
}

/** GHASH：对 16 字节整数倍的输入做认证。输入长度不足时由调用方补齐。 */
function ghash(h, data) {
    let y = new Uint8Array(16);
    for (let off = 0; off < data.length; off += 16) {
        const blk = new Uint8Array(16);
        for (let i = 0; i < 16; i++) blk[i] = y[i] ^ (data[off + i] || 0);
        y = gf128Mul(blk, h);
    }
    return y;
}

/** 计数器自增（只增低 32 位，GCM 规定） */
function inc32(block) {
    const b = copyBytes(block);
    let c = ((b[12] << 24) | (b[13] << 16) | (b[14] << 8) | b[15]) >>> 0;
    c = (c + 1) >>> 0;
    b[12] = (c >>> 24) & 0xff; b[13] = (c >>> 16) & 0xff;
    b[14] = (c >>> 8) & 0xff; b[15] = c & 0xff;
    return b;
}

/** GCTR：计数器模式，从 icb 起逐块异或。 */
function gctr(rkCtx, icb, input) {
    if (!input.length) return new Uint8Array(0);
    const out = new Uint8Array(input.length);
    let cb = copyBytes(icb);
    for (let off = 0; off < input.length; off += 16) {
        const { rk, Nr } = rkCtx;
        // E(cb)
        let s = copyBytes(cb);
        addRoundKey(s, rk, 0);
        for (let r = 1; r < Nr; r++) { subBytes(s); shiftRows(s); mixColumns(s); addRoundKey(s, rk, r); }
        subBytes(s); shiftRows(s); addRoundKey(s, rk, Nr);

        const n = Math.min(16, input.length - off);
        for (let i = 0; i < n; i++) out[off + i] = input[off + i] ^ s[i];
        cb = inc32(cb);
    }
    return out;
}

/** 由 96bit IV 导出 J0；其他长度按规范 GHASH。本项目恒为 12 字节。 */
function deriveJ0(rkCtx, iv) {
    if (iv.length === 12) {
        return concat(iv, new Uint8Array([0, 0, 0, 1]));
    }
    // 通用路径：J0 = GHASH(H, IV ‖ 0^s ‖ 0^64 ‖ [len(IV)]_64)
    const h = aesEncryptBlockFromCtx(rkCtx, new Uint8Array(16));
    const padLen = (16 - ((iv.length + 8) % 16)) % 16;
    const data = concat(iv, new Uint8Array(padLen), new Uint8Array(8), lenBits64(iv.length));
    return ghash(h, data);
}

function aesEncryptBlockFromCtx(rkCtx, block) {
    const { rk, Nr } = rkCtx;
    const s = copyBytes(block);
    addRoundKey(s, rk, 0);
    for (let r = 1; r < Nr; r++) { subBytes(s); shiftRows(s); mixColumns(s); addRoundKey(s, rk, r); }
    subBytes(s); shiftRows(s); addRoundKey(s, rk, Nr);
    return s;
}

function lenBits64(byteLen) {
    const b = new Uint8Array(8);
    const bits = byteLen * 8;
    const hi = Math.floor(bits / 0x100000000), lo = bits >>> 0;
    b[0] = (hi >>> 24) & 0xff; b[1] = (hi >>> 16) & 0xff;
    b[2] = (hi >>> 8) & 0xff; b[3] = hi & 0xff;
    b[4] = (lo >>> 24) & 0xff; b[5] = (lo >>> 16) & 0xff;
    b[6] = (lo >>> 8) & 0xff; b[7] = lo & 0xff;
    return b;
}

/**
 * AES-GCM 加密。输出格式与 WebCrypto `subtle.encrypt({name:'AES-GCM'})` 一致：
 * **ciphertext ‖ tag(16B)**。
 * @param {Uint8Array} key    32 字节（AES-256）
 * @param {Uint8Array} iv     12 字节
 * @param {Uint8Array} plain
 * @param {Uint8Array} [aad]  附加认证数据（本项目不用）
 * @returns {Uint8Array}
 */
export function gcmSeal(key, iv, plain, aad) {
    const k = u8(key), ivB = u8(iv), p = u8(plain), a = aad ? u8(aad) : new Uint8Array(0);
    if (ivB.length === 0) throw new Error('AES-GCM: IV 不能为空');
    const rkCtx = aesExpandKey(k);

    const h = aesEncryptBlockFromCtx(rkCtx, new Uint8Array(16));
    const j0 = deriveJ0(rkCtx, ivB);
    const ct = gctr(rkCtx, inc32(j0), p);

    // S = GHASH(A ‖ pad ‖ C ‖ pad ‖ [len(A)]64 ‖ [len(C)]64)
    const padA = (16 - (a.length % 16)) % 16;
    const padC = (16 - (ct.length % 16)) % 16;
    const s = ghash(h, concat(a, new Uint8Array(padA), ct, new Uint8Array(padC),
                              lenBits64(a.length), lenBits64(ct.length)));

    const ek = aesEncryptBlockFromCtx(rkCtx, j0);
    const tag = new Uint8Array(16);
    for (let i = 0; i < 16; i++) tag[i] = ek[i] ^ s[i];

    return concat(ct, tag);
}

/**
 * AES-GCM 解密。输入为 **ciphertext ‖ tag(16B)**（与 WebCrypto 相同）。
 * 认证失败抛出 Error（与 WebCrypto 行为一致，调用方据此报“认证失败”）。
 * @returns {Uint8Array} 明文
 */
export function gcmOpen(key, iv, cipher, aad) {
    const k = u8(key), ivB = u8(iv), c = u8(cipher), a = aad ? u8(aad) : new Uint8Array(0);
    if (c.length < 16) throw new Error('AES-GCM: 密文短于 tag');
    if (ivB.length === 0) throw new Error('AES-GCM: IV 不能为空');

    const rkCtx = aesExpandKey(k);
    const ct = c.subarray(0, c.length - 16);
    const tag = c.subarray(c.length - 16);

    const h = aesEncryptBlockFromCtx(rkCtx, new Uint8Array(16));
    const padA = (16 - (a.length % 16)) % 16;
    const padC = (16 - (ct.length % 16)) % 16;
    const s = ghash(h, concat(a, new Uint8Array(padA), ct, new Uint8Array(padC),
                              lenBits64(a.length), lenBits64(ct.length)));
    const j0 = deriveJ0(rkCtx, ivB);
    const ek = aesEncryptBlockFromCtx(rkCtx, j0);
    const expect = new Uint8Array(16);
    for (let i = 0; i < 16; i++) expect[i] = ek[i] ^ s[i];

    if (!timingSafeEqual(expect, tag)) {
        throw new Error('AES-GCM: 认证失败（tag 不匹配）');
    }
    return gctr(rkCtx, inc32(j0), ct);
}

/* ───────────────────────────────────────────────────────────────
 * 7. 默认导出（便于门面按对象引用）
 * ─────────────────────────────────────────────────────────────── */

export default {
    sha256, hmacSha256, hkdf, pbkdf2,
    gcmSeal, gcmOpen, aesEncryptBlock,
    /** 自检：S-box 是程序化生成的，抽查已知值 */
    _selftest: () => SBOX[0x00] === 0x63 && SBOX[0x01] === 0x7c && SBOX[0x53] === 0xed,
    _SBOX: SBOX
};
