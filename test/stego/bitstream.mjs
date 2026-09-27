/* ═══════════════════════════════════════════════════════════════════
 * 语言隐写适配层 · 6-bit 位流读写器
 * ═══════════════════════════════════════════════════════════════════
 *
 * 每个伪装 token 承载 6 bit（top-64 名次）。要求：
 *   ① 读写对称、无损；
 *   ② 越界读零并**计数**（overrunBits），便于断言"帧长是否 6bit 整除"；
 *   ③ 残位必须可查 —— 66/192 这类"整数个 6bit 周期"的帧长，残位应恒为 0。
 *
 * 关键算术：192 字节 × 8 = 1536 bit = 256 × 6 bit，整除 → 残位 0。
 *           66 字节 × 8 =  528 bit =  88 × 6 bit，整除 → 残位 0。
 *           64 字节 × 8 =  512 bit → 512 % 6 = 2，**不整除**（原规范选 64 是错的）。
 */

export class BitWriter {
    constructor(k = 6) { this.k = k; this.acc = 0; this.n = 0; this.out = []; }
    write(v) {
        const mask = (1 << this.k) - 1;
        this.acc = ((this.acc << this.k) | (v & mask)) >>> 0;
        this.n += this.k;
        while (this.n >= 8) { this.n -= 8; this.out.push((this.acc >>> this.n) & 0xff); }
        this.acc = this.n ? (this.acc & ((1 << this.n) - 1)) : 0;
        return this;
    }
    /** 收尾：残位左对齐补零。k=6 且 8*len 能被 6 整除时 n 恒为 0。 */
    finish() {
        if (this.n > 0) { this.out.push((this.acc << (8 - this.n)) & 0xff); this.n = 0; this.acc = 0; }
        return Uint8Array.from(this.out);
    }
    get residualBits() { return this.n; }
}

export class BitReader {
    constructor(bytes, k = 6) {
        this.k = k; this.b = bytes; this.i = 0;
        this.acc = 0; this.n = 0;
        this.consumedBits = 0; this.overrunBits = 0;
    }
    read() {
        while (this.n < this.k) {
            let byte = 0;
            if (this.i < this.b.length) { byte = this.b[this.i++]; }
            else { /* 越界：补零，由下方 consumed 记账 */ }
            this.acc = ((this.acc << 8) | byte) >>> 0;
            this.n += 8;
        }
        this.n -= this.k;
        const v = (this.acc >>> this.n) & ((1 << this.k) - 1);
        this.acc = this.n ? (this.acc & ((1 << this.n) - 1)) : 0;
        // 越界记账：每个单元恰好消费 k 位，累计消费位数超过真实数据位数即为越界单元。
        this.consumedBits += this.k;
        if (this.consumedBits > this.b.length * 8) this.overrunBits++;
        return v;
    }
    /** 是否已读到真实数据之外 */
    get pastEnd() { return this.consumedBits > this.b.length * 8; }
}

/** 字节 → k-bit 单元数组（只取能整除的整数个单元） */
export function unitsFromBytes(bytes, k = 6) {
    const r = new BitReader(bytes, k);
    const total = Math.floor((bytes.length * 8) / k);
    const out = new Array(total);
    for (let i = 0; i < total; i++) out[i] = r.read();
    return out;
}

/** k-bit 单元数组 → 字节（残位补零） */
export function bytesFromUnits(units, k = 6) {
    const w = new BitWriter(k);
    for (let i = 0; i < units.length; i++) w.write(units[i]);
    return w.finish();
}

/** 帧长是否恰好能被 6bit 整除（0 = 完全整除，无残位） */
export function residualOfFrame(byteLen, k = 6) {
    return (byteLen * 8) % k;
}
