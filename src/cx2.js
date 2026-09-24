/* ═══════════════════════════════════════════════════════════════════
 * 文本信道 v2 加密引擎（CX2）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 设计要点
 * --------
 *  * 密钥派生用 HKDF-SHA256（而非把 X25519 共享密钥直接当 AES 密钥），
 *    并做 domain separation：wrap 与 content 用不同 salt。
 *  * 抗重放：临时公钥 eph_pk 每包唯一，且绑进 HKDF 的 info。
 *  * 一对多：**共享会话密钥**（content_key 只加密一次正文），
 *    对每个接收方各自 wrap 一把 content_key —— 每人只增加 52 字节，
 *    而非每人一份完整密文。
 *  * 收件人隐私（P2 盲索引）：每份 wrap 前放 8 字节盲索引
 *    idx = HKDF(shared)[:8]，接收方算一次自己的 idx 即可命中，
 *    解密 O(1)，且外人无法反查收件人身份。
 *
 * 线格式（v2，Base64 形态）
 * ------------------------
 *   ver(1B=0x02) ‖ flags(1B) ‖ N(1B) ‖ [ idx(8B) ‖ eph_pk(32B) ‖ iv(12B) ‖ wrapped(48B) ] × N
 *                                        ‖ iv_ct(12B) ‖ ct(明文长 + 16B tag)
 *
 *   wrapped = AES-256-GCM(wrap_key, content_key(32B)) = 32B ct + 16B tag = 48B
 *
 * 单播（N=1）与群发共用同一套代码，不存在第二条分支。
 *
 * ⚠️ 与 v1（k/i/c 的 JSON 封装 + 裸共享密钥）**不兼容**，按需求不做向下兼容。
 */
const CX2 = (function () {
    'use strict';

    const VERSION = 0x02;
    const SALT_WRAP = 'CX-V2-WRAP';      // 包裹密钥的域分隔
    const SALT_IDX = 'CX-V2-IDX';        // 盲索引的域分隔
    const SALT_CT = 'CX-V2-CT';          // 正文加密的域分隔（HKDF 直接导出 content_key 用不到，保留作扩展）

    const WRAP_LEN = 48;                 // 32 字节 content_key + 16 字节 GCM tag
    const IDX_LEN = 8;
    const EPH_LEN = 32;
    const IV_LEN = 12;
    const KEY_LEN = 32;

    const enc = new TextEncoder();
    const dec = new TextDecoder();

    /* ── 编解码小工具 ── */
    const u8 = (...parts) => {
        const n = parts.reduce((a, p) => a + p.length, 0);
        const out = new Uint8Array(n);
        let o = 0;
        for (const p of parts) { out.set(p, o); o += p.length; }
        return out;
    };
    /* 与角色无关的绑定：(字节序较小者 ‖ 较大者)，两侧算出的 bind 必然相同 */
    const u8cmp = (a, b) => {
        const n = Math.min(a.length, b.length);
        for (let i = 0; i < n; i++) {
            if (a[i] !== b[i]) return a[i] < b[i] ? u8(a, b) : u8(b, a);
        }
        return a.length <= b.length ? u8(a, b) : u8(b, a);
    };
    const b64 = buf => btoa(String.fromCharCode(...new Uint8Array(buf)));
    const unb64 = s => {
        const bin = atob(String(s).replace(/\s+/g, ''));
        const b = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
        return b;
    };

    /* ── X25519：复用页面的纯 JS 实现（TA.M.m），避免重复实现 ── */
    function x25519(scalar, point) { return TA.M.m(scalar, point); }

    /* ── HKDF-SHA256 → 32 字节 ── */
    async function hkdf(ikm, salt, info) {
        const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
        const bits = await crypto.subtle.deriveBits(
            { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(salt), info: enc.encode(info) },
            k, KEY_LEN * 8
        );
        return new Uint8Array(bits);
    }

    /* ── AES-256-GCM ── */
    async function gcmSeal(key, iv, plain) {
        const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
        return new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, plain));
    }
    async function gcmOpen(key, iv, cipher) {
        const k = await crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, cipher));
    }

    /* ── 对单个接收方算出 (wrap_key, idx) ──
     *
     * 发送方：  deriveFor(ephSk, ephPk, peerPk)   → shared = X25519(ephSk, peerPk)
     * 接收方：  deriveFor(mySk,  myPk,  ephPk)   → shared = X25519(mySk,  ephPk)
     *
     * 两个角色**参数顺序不同**：枢纽是「用自己的私钥标量 + 对方的公钥点」。
     * bind 必须与角色无关，故按字节序归一到 (小 ‖ 大)，否则
     * 发送方绑 (ephPk,peerPk)、接收方绑 (myPk,ephPk) 会得到不同 info，
     * 进而派生出不同密钥（修复前的真实缺陷即在此）。
     */
    async function deriveFor(ownSk, ownPk, peerPk) {
        const shared = x25519(ownSk, peerPk);
        const bind = u8cmp(ownPk, peerPk);
        const wrapKey = await hkdf(shared, SALT_WRAP,
            'wrap|' + b64(bind));
        const idxFull = await hkdf(shared, SALT_IDX,
            'idx|' + b64(bind));
        return { wrapKey, idx: idxFull.slice(0, IDX_LEN) };
    }

    /* ── 加密：明文 + 多个接收方公钥 → Base64 密文 ──
     * peers: Uint8Array(32) 或 Base64 字符串 的数组（至少 1 个）
     */
    async function encrypt(plaintext, peers) {
        if (!window.crypto?.subtle) throw new Error('当前环境不支持 Web Crypto API，请使用 HTTPS 或 localhost 访问');
        const list = (peers || []).map(p => (typeof p === 'string' ? unb64(p) : p));
        if (!list.length) throw new Error('至少需要一个接收方公钥');
        for (const p of list) {
            if (!p || p.length !== 32) throw new Error('接收方公钥必须是 32 字节');
        }
        if (list.length > 255) throw new Error('接收方数量超过上限 255');

        // ① 共享会话密钥：正文只加密一次
        const contentKey = crypto.getRandomValues(new Uint8Array(KEY_LEN));
        const ivCt = crypto.getRandomValues(new Uint8Array(IV_LEN));
        const ct = await gcmSeal(contentKey, ivCt, enc.encode(plaintext));

        // ② 每个接收方各 wrap 一份 content_key
        const ephSk = crypto.getRandomValues(new Uint8Array(32));
        const ephPk = x25519(ephSk, null);            // 只用公钥分量，不依赖对方私钥
        const recs = [];
        for (const peerPk of list) {
            const { wrapKey, idx } = await deriveFor(ephSk, ephPk, peerPk);
            const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
            const wrapped = await gcmSeal(wrapKey, iv, contentKey);
            if (wrapped.length !== WRAP_LEN) throw new Error('包裹长度异常');
            recs.push(u8(idx, ephPk, iv, wrapped));
        }

        const head = new Uint8Array([VERSION, 0x00, list.length]);
        const body = u8(head, ...recs, ivCt, ct);
        return b64(body);
    }

    /* ── 解密：Base64 密文 + 本机私钥 → 明文 ──
     * 找不到自己那一份时抛错（不是本消息的接收方 / 密文损坏）
     */
    async function decrypt(cipherB64, mySk) {
        // 先把「环境/加载问题」与「真正的解密失败」分开报，避免都变成
        // 「认证失败」这种指向错误原因的提示
        if (!mySk || mySk.length !== 32) {
            throw new Error('本机私钥不可用（请先点「初始化身份」）');
        }
        if (!window.crypto?.subtle) throw new Error('当前环境不支持 Web Crypto API，请使用 HTTPS 或 localhost 访问');
        let buf;
        try { buf = unb64(cipherB64); }
        catch (e) { throw new Error('密文不是有效的 Base64，可能被截断或复制不全'); }
        if (buf.length < 3) throw new Error('密文过短，不是本工具生成的密文');
        if (buf[0] !== VERSION) throw new Error('密文版本不匹配（期望 v2，实际 0x' + buf[0].toString(16) + '）');

        const n = buf[2];
        if (n < 1) throw new Error('密文声明了 0 个接收方，已损坏');
        const recLen = IDX_LEN + EPH_LEN + IV_LEN + WRAP_LEN;
        const need = 3 + recLen * n + IV_LEN + 16;      // +16 = GCM tag 下限
        if (buf.length < need) throw new Error('密文长度不足，可能被截断（缺少 ' + (need - buf.length) + ' 字节）');

        const myPk = x25519(mySk, null);
        let contentKey = null;

        // 扫每一份，用盲索引快速比对；命中即试解封
        for (let i = 0; i < n; i++) {
            const off = 3 + i * recLen;
            const idx = buf.subarray(off, off + IDX_LEN);
            const ephPk = buf.subarray(off + IDX_LEN, off + IDX_LEN + EPH_LEN);
            const iv = buf.subarray(off + IDX_LEN + EPH_LEN, off + IDX_LEN + EPH_LEN + IV_LEN);
            const wrapped = buf.subarray(off + IDX_LEN + EPH_LEN + IV_LEN, off + recLen);

            const { wrapKey, idx: mine } = await deriveFor(mySk, myPk, ephPk);
            // 盲索引命中（等长比较，避免时序侧信道）
            let hit = true;
            for (let j = 0; j < IDX_LEN; j++) if (idx[j] !== mine[j]) hit = false;
            if (!hit) continue;

            try {
                contentKey = await gcmOpen(wrapKey, iv, wrapped);
                break;
            } catch (e) {
                // 索引碰撞（8 字节概率极低）→ 继续找下一份
                continue;
            }
        }

        if (!contentKey) {
            throw new Error('这条密文不是发给你的（未找到匹配的收件人标识），或密文已被篡改');
        }

        const ctOff = 3 + recLen * n;
        const ivCt = buf.subarray(ctOff, ctOff + IV_LEN);
        const ct = buf.subarray(ctOff + IV_LEN);
        try {
            return dec.decode(await gcmOpen(contentKey, ivCt, ct));
        } catch (e) {
            throw new Error('认证失败：正文密文与密钥不匹配，内容可能已被篡改');
        }
    }

    /* ── 解析头部（供 UI 展示：版本/收件人数） ── */
    function inspect(cipherB64) {
        try {
            const b = unb64(cipherB64);
            return { version: b[0], recipients: b[2], bytes: b.length };
        } catch (e) { return null; }
    }

    return { VERSION, encrypt, decrypt, inspect, IDX_LEN, WRAP_LEN, EPH_LEN, IV_LEN, recLen: IDX_LEN + EPH_LEN + IV_LEN + WRAP_LEN };
})();
