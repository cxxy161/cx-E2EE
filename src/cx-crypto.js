/* ═══════════════════════════════════════════════════════════════════
 * 密码学门面（cx-crypto / SC）
 * ═══════════════════════════════════════════════════════════════════
 *
 * 解决的问题
 * ----------
 *   非安全上下文（手机经局域网 http://192.168.x.x 访问）下
 *   **`crypto.subtle` 是 undefined**，而 `crypto.getRandomValues` 仍可用。
 *   旧代码直接 `throw "当前环境不支持 Web Crypto API"`，等于整个页面不可用。
 *
 *   本门面提供统一入口：优先用原生 WebCrypto，缺失时**惰性**加载
 *   `vendor/cx-softcrypto.mjs`（纯 JS 实现），使链路继续可用。
 *
 * ⚠️ 安全边界（调用方必须原样呈现给使用者）
 * -----------------------------------------
 *   soft 模式只解决「能不能算」，**不能**把 http 变成安全信道：
 *   页面脚本本身可被中间人篡改，能改 JS 就能偷口令。
 *   因此 soft 模式**必须**展示常驻警告条（见 pageNotice / onMode）。
 *
 * 接口（全部 async，长度单位一律为**字节**）
 * ----------------------------------------
 *   SC.ensure()                        → 'native' | 'soft'
 *   SC.mode()                          → 'native' | 'soft' | 'unknown'
 *   SC.sha256(bytes)                   → Uint8Array(32)
 *   SC.hkdf(ikm, salt, info, len)      → Uint8Array(len)
 *   SC.pbkdf2(pw, salt, iter, len)     → Uint8Array(len)
 *   SC.gcmSeal(key, iv, plain)         → Uint8Array(ct ‖ tag)
 *   SC.gcmOpen(key, iv, cipher)        → Uint8Array(plain)；认证失败抛 Error
 *
 * 兼容性
 * ------
 *   **不改线格式**：两种模式产出逐字节相同，故 http 端发的包 https 端能解。
 *   （已由 test/softcrypto-vectors.mjs 与 OpenSSL 对拍验证）
 * ═══════════════════════════════════════════════════════════════════ */
(function (root) {
    'use strict';

    const SOFT_PATH = './vendor/cx-softcrypto.mjs';

    const SC = {
        _mode: 'unknown',      // 'unknown' | 'native' | 'soft'
        _soft: null,           // 纯 JS 模块命名空间
        _loading: null,        // 并发 ensure() 时复用同一个 Promise
        _err: null,            // 加载失败原因
        onMode: null,          // (mode) => void，页面用它弹警告条

        /** 原子随机数：http 下也可用，不属于 SubtleCrypto */
        rand(n) {
            const c = root.crypto || root.msCrypto;
            if (!c || typeof c.getRandomValues !== 'function') {
                throw new Error('当前环境无可用的安全随机数源（crypto.getRandomValues 缺失）');
            }
            return c.getRandomValues(new Uint8Array(n));
        },

        /**
         * 确认可用后端，必要时加载纯 JS 实现。
         * 幂等且并发安全（多次调用共享同一个加载 Promise）。
         * @returns {Promise<'native'|'soft'>}
         */
        ensure() {
            if (this._mode !== 'unknown') return Promise.resolve(this._mode);
            if (this._loading) return this._loading;

            this._loading = (async () => {
                // ① 优先原生
                const c = root.crypto;
                if (c && c.subtle && typeof c.subtle.importKey === 'function') {
                    this._mode = 'native';
                } else {
                    // ② 回退：动态加载纯 JS 实现（原生可用时**不会**产生这次下载）
                    try {
                        const mod = await import(SOFT_PATH);
                        if (!mod || typeof mod.gcmSeal !== 'function') {
                            throw new Error('模块导出不完整');
                        }
                        this._soft = mod;
                        this._mode = 'soft';
                    } catch (e) {
                        this._err = e;
                        this._loading = null;   // 允许重试
                        throw new Error(
                            '当前环境既无 Web Crypto（crypto.subtle 不可用），纯 JS 回退也加载失败：' +
                            (e && e.message ? e.message : e) +
                            '。请用 localhost / HTTPS 访问，或检查 vendor/cx-softcrypto.mjs 是否可访问'
                        );
                    }
                }
                if (typeof this.onMode === 'function') {
                    try { this.onMode(this._mode); } catch (e) { /* 通知失败不影响主流程 */ }
                }
                return this._mode;
            })();

            return this._loading;
        },

        /** 当前后端（未 ensure 时为 'unknown'） */
        mode() { return this._mode; },
        isSoft() { return this._mode === 'soft'; },

        /* ── 原语：native 分支 ───────────────────────────────── */

        async _nSha256(bytes) {
            return new Uint8Array(await root.crypto.subtle.digest('SHA-256', bytes));
        },

        async _nHkdf(ikm, salt, info, len) {
            const k = await root.crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
            const bits = await root.crypto.subtle.deriveBits(
                { name: 'HKDF', hash: 'SHA-256', salt, info }, k, len * 8
            );
            return new Uint8Array(bits);
        },

        async _nPbkdf2(pw, salt, iterations, len) {
            const k = await root.crypto.subtle.importKey('raw', pw, 'PBKDF2', false, ['deriveBits']);
            const bits = await root.crypto.subtle.deriveBits(
                { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, k, len * 8
            );
            return new Uint8Array(bits);
        },

        async _nGcmSeal(key, iv, plain) {
            const k = await root.crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['encrypt']);
            return new Uint8Array(await root.crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, plain));
        },

        async _nGcmOpen(key, iv, cipher) {
            const k = await root.crypto.subtle.importKey('raw', key, 'AES-GCM', false, ['decrypt']);
            return new Uint8Array(await root.crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, cipher));
        },

        /* ── 原语：统一入口 ─────────────────────────────────── */

        async sha256(bytes) {
            const m = await this.ensure();
            return m === 'native' ? this._nSha256(bytes) : this._soft.sha256(bytes);
        },

        async hkdf(ikm, salt, info, len) {
            const m = await this.ensure();
            return m === 'native'
                ? this._nHkdf(ikm, salt, info, len)
                : this._soft.hkdf(ikm, salt, info, len);
        },

        async pbkdf2(pw, salt, iterations, len) {
            const m = await this.ensure();
            return m === 'native'
                ? this._nPbkdf2(pw, salt, iterations, len)
                : this._soft.pbkdf2(pw, salt, iterations, len);
        },

        async gcmSeal(key, iv, plain) {
            const m = await this.ensure();
            return m === 'native'
                ? this._nGcmSeal(key, iv, plain)
                : this._soft.gcmSeal(key, iv, plain);
        },

        async gcmOpen(key, iv, cipher) {
            const m = await this.ensure();
            return m === 'native'
                ? this._nGcmOpen(key, iv, cipher)
                : this._soft.gcmOpen(key, iv, cipher);
        },

        /* ── UI 辅助：soft 模式的常驻警告文案 ───────────────── */

        /**
         * 返回需要展示的警告文案（native 返回 null）。
         * 文案刻意写清「能算」与「不安全」的区别，避免使用者误以为 http 变安全了。
         */
        warnText() {
            if (this._mode !== 'soft') return null;
            return '当前为纯 JS 回退加密 · 页面处于非安全上下文（http）。' +
                   '加密结果与原生一致，但本页脚本可被中间人篡改 —— 请仅在可信局域网使用。';
        },

        /**
         * 挂载/更新警告条。
         *
         * 页面若已有 `#sc-warn`（内含 `#sc-warn-tx`）则复用，否则**自动创建**并插到
         * 主容器顶部 —— 这样各页只要引入本文件就不会漏挂（漏挂等于静默降级）。
         */
        mountNotice() {
            let box = document.getElementById('sc-warn');
            let tx = document.getElementById('sc-warn-tx');
            const msg = this.warnText();

            if (!box) {
                if (!msg) return null;                  // native 且无占位元素：无需创建
                box = document.createElement('div');
                box.id = 'sc-warn';
                box.className = 'note warn';
                box.style.cssText = 'display:none;margin-bottom:14px;padding:11px 13px;border-radius:10px;' +
                    'border:1px solid #d97706;background:#fef3c7;color:#92400e;font-size:.78rem;line-height:1.6';
                tx = document.createElement('span');
                tx.id = 'sc-warn-tx';
                box.appendChild(tx);
                const host = document.querySelector('.box') || document.body;
                host.insertBefore(box, host.firstChild);
            } else if (!tx) {
                tx = document.createElement('span');
                tx.id = 'sc-warn-tx';
                box.appendChild(tx);
            }

            if (!msg) { box.style.display = 'none'; return box; }
            tx.textContent = msg;
            box.style.display = 'flex';
            return box;
        }
    };

    /* onMode 默认实现：任何引入了本文件的页面都会自动挂警告条。
     * 页面可覆盖 SC.onMode 做额外处理，但**不得**让它静默降级。 */
    SC.onMode = function () { SC.mountNotice(); };

    root.SC = SC;
})(typeof window !== 'undefined' ? window : globalThis);
