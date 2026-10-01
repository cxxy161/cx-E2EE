window.addEventListener('error', (e) => {
    T('异常: ' + (e.error?.message || e.message || '脚本错误'));
});
window.addEventListener('unhandledrejection', (e) => {
    T('异常: ' + (e.reason?.message || e.reason || '未知错误'));
});

const $ = (i) => document.getElementById(i);

/* ── 部署形态判定 ──
 * GitHub Pages 是纯静态托管，没有 server/server.js 提供的 PKI API。
 * 那里 fetch('/api/...') 会被 Pages 当成不存在的路径，返回 404（且响应体是 HTML
 * 而非 JSON），若不拦截就会把「后端根本不存在」误报成「未找到该ID」——
 * 指向完全错误的原因，极难排查。这里显式判定并给出准确说明。
 * 自托管的生产站（有 Express 后端）会走正常路径，完全不受影响。 */
const StaticHost = {
    get is() {
        const h = location.hostname;
        return /\.github\.io$/i.test(h) || /\.githubpages\.com$/i.test(h);
    },
    get msg() {
        return '本页部署在 GitHub Pages（纯静态、无后端），公钥库功能不可用';
    }
};

// 动态注入全局 Toast（复制失败不再弹回退框：内容本就在页面输出框里，用户可直接选中复制）
document.addEventListener("DOMContentLoaded", () => {
    if (!$('tst')) {
        let t = document.createElement('div'); t.id = 'tst'; document.body.appendChild(t);
    }
});

const T = (m) => { 
    let t = $('tst'); if (!t) return; 
    t.innerText = m; t.className = 'on'; 
    clearTimeout(t.tm); t.tm = setTimeout(() => t.className = '', 2000);
};

const CP = (i, isId) => {
    let t;
    if (isId) {
        // 传的是元素 id：元素不存在时直接返回，不再抛异常
        let el = $(i);
        if (!el) return;
        t = el.value || el.innerText;
    } else {
        t = i;
    }
    if (!t) return;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(t)
            .then(() => T("已复制"))
            .catch(() => T("自动复制被浏览器拦截，请手动选中内容复制"));
        return;
    }
    // 非安全上下文（如手机经局域网 http 访问）没有剪贴板权限：
    // 内容本来就在页面输出框里可见，直接提示用户手动复制即可
    T("当前环境不支持自动复制，请手动选中内容复制");
};

function TS(t) {
    document.querySelectorAll('.mt').forEach(e => e.classList.remove('on'));
    let btn = $(`mt-${t}`); if (btn) btn.classList.add('on');
    document.querySelectorAll('.sp').forEach(e => e.classList.remove('on'));
    let sp = $(`sp-${t}`); if (sp) sp.classList.add('on');
}

// 字节转换工具
const Util = {
    b642buf: (b64) => {
        try {
            const bin = atob(b64.replace(/\s+/g, ''));
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
            return bytes.buffer;
        } catch { return null; }
    },
    buf2b64: (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))),
    buf2hex: (buffer) => Array.from(new Uint8Array(buffer)).map(b => b.toString(16).padStart(2, '0')).join(''),
    hex2buf: (hex) => {
        const c = hex.replace(/\s+/g, ''); if (c.length % 2 !== 0) return null;
        return new Uint8Array(c.match(/.{1,2}/g).map(byte => parseInt(byte, 16)));
    }
};

const Directory = {
    store: 'cx_contacts',
    data: {},
    _onEncFill: null,
    _onSigFill: null,
    _lastContainer: null,
    _lastType: null,

    load() {
        try { this.data = JSON.parse(localStorage.getItem(this.store)) || {}; }
        catch { this.data = {}; }
    },
    save() { localStorage.setItem(this.store, JSON.stringify(this.data)); },
    getAll() { return Object.values(this.data); },
    has(id) { return !!this.data[id]; },
    get(id) { return this.data[id] || null; },

    add(id, signingPubkey, encryptionPubkey, nickname) {
        this.data[id] = {
            id: id,
            nickname: nickname || (this.data[id] ? this.data[id].nickname : ''),
            signing_pubkey: signingPubkey || '',
            encryption_pubkey: encryptionPubkey || '',
            timestamp: Date.now()
        };
        this.save();
    },

    remove(id) {
        delete this.data[id];
        this.save();
    },

    async pullFromRemote(id) {
        if (!id || !id.trim()) throw '请输入ID';
        // 静态托管上没有 /api 路由，提前抛出准确原因（否则会误报「未找到该ID」）
        if (StaticHost.is) throw StaticHost.msg;
        const resp = await fetch('/api/pubkey/' + encodeURIComponent(id.trim()));
        if (!resp.ok) {
            if (resp.status === 404) throw '未找到该ID';
            throw '服务器错误: ' + resp.status;
        }
        const entry = await resp.json();
        this.data[entry.id] = {
            id: entry.id,
            nickname: this.data[entry.id] ? this.data[entry.id].nickname : '',
            signing_pubkey: entry.signing_pubkey,
            encryption_pubkey: entry.encryption_pubkey,
            timestamp: entry.timestamp
        };
        this.save();
        return this.data[entry.id];
    },

    _esc(s) {
        return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    },
    _trunc(s) {
        if (!s) return '—';
        return s.length > 24 ? s.substring(0, 11) + '...' + s.substring(s.length - 8) : s;
    },

    _onRowClick(id, primaryType) {
        var e = this.data[id];
        if (!e) return;
        if (primaryType === 'sign' && this._onSigFill && e.signing_pubkey) this._onSigFill(e.signing_pubkey);
        if (primaryType === 'enc' && this._onEncFill && e.encryption_pubkey) this._onEncFill(e.encryption_pubkey);
    },

    render(containerId, primaryType) {
        this._lastContainer = containerId;
        this._lastType = primaryType;
        var c = $(containerId);
        if (!c) return;
        c.innerHTML = '';
        var all = this.getAll();
        if (!all.length) {
            c.innerHTML = '<div style="text-align:center;color:#666;font-size:.8rem;padding:10px">空</div>';
            return;
        }
        var esc = this._esc.bind(this);
        var trunc = this._trunc.bind(this);
        var html = '';
        for (var i = 0; i < all.length; i++) {
            var e = all[i];
            var key = primaryType === 'sign' ? (e.signing_pubkey || '') : (e.encryption_pubkey || '');
            var label = primaryType === 'sign' ? 'S:' : 'E:';
            var name = e.nickname || e.id;
            var rid = e.id;
            html += '<div class="crow">' +
                '<div class="cinf" onclick="Directory._onRowClick(\'' + esc(rid) + '\',\'' + primaryType + '\')">' +
                '<div class="cnm">' + esc(name) + '</div>' +
                '<div class="cky"><span class="klbl">' + label + '</span><span title="' + esc(key) + '">' + esc(trunc(key)) + '</span>' +
                (key ? '<span class="kcp" onclick="event.stopPropagation();CP(\'' + key.replace(/'/g,'\\\'') + '\',false)">复制</span>' : '') +
                '</div>' +
                '</div>' +
                '<div class="cdel" onclick="if(confirm(\'\\u786e\\u5b9a\\u5220\\u9664\\uff1f\')){Directory.remove(\'' + esc(rid) + '\');Directory.render(\'' + containerId + '\',\'' + primaryType + '\')}">×</div>' +
                '</div>';
        }
        c.innerHTML = html;
    },

    exp() {
        if (!Object.keys(this.data).length) return T('列表为空');
        CP(JSON.stringify(this.data), false);
    },
    imp() {
        var s = prompt('粘贴通讯录备份代码:');
        if (!s) return;
        try {
            var obj = JSON.parse(s);
            if (typeof obj !== 'object') throw 1;
            if (confirm('覆盖(OK) 还是 合并(Cancel)?')) {
                this.data = obj;
            } else {
                for (var k in obj) {
                    if (!Object.prototype.hasOwnProperty.call(obj, k)) continue;
                    if (!this.data[k]) this.data[k] = obj[k];
                }
            }
            this.save();
            this.render(this._lastContainer, this._lastType);
            T('导入成功');
        } catch (e) { T('数据无效'); }
    }
};
Directory.load();

// ─── 助记句遮罩 (Veil) ───
//
// 用途：防肩窥。点一下按钮把整个输入框盖住，再点一下恢复。
//
// ⚠️ 为什么不做「实时隐藏」（这是踩过坑的地方，别再改回去）
// ---------------------------------------------------------
//   type=password / -webkit-text-security / color:transparent / compositionstart 守卫
//   这四种做法都会**打断中文输入法的组字候选窗**，导致中文口令无法输入。
//   见 test/pass-field.mjs（该测试就是为了防止回归到那些做法而写的）。
//
// 本实现与输入法完全解耦：
//   ① 只在「主动点击」时切换，途中不监听任何输入事件（oninput 一个字节都不加）；
//   ② 用绝对定位的不透明遮罩层盖住，不碰输入框自身的任何样式或 type；
//   ③ 遮蔽时先 blur() 让输入法收摊，再设 readonly —— 原生属性，零事件拦截。
//
// ⚠️ 定位：这是**防肩窥，不是加密**。value 始终在内存与 DOM 里，遮蔽期间不变。
//
// ⚠️ 隐藏遮罩不能只设 `hidden` 属性（这是上线后踩到的真实 bug）
// ------------------------------------------------------------
//   只设 `hidden` **不够**：`.veil{display:flex}` 是作者样式，优先级高于 UA 样式表的
//   `[hidden]{display:none}` —— hidden 形同虚设，遮罩从页面加载起就一直盖住输入框，
//   表现为「点不到、光标不显示、无法输入」。
//   CSS 侧已补 `.veil[hidden]{display:none!important}`，这里再用**内联样式**兜底：
//   内联优先级最高，且不依赖各页是否引入了那条 CSS 规则。
const Veil = {
    /* inputId → { input, veil, btn } */
    _map: {},

    /**
     * 绑定一组「输入框 + 遮罩层 + 按钮」。
     * @param {string} inputId 输入框 id
     * @param {string} veilId  遮罩层 id（建议 position:absolute 覆盖输入框）
     * @param {string} btnId   切换按钮 id（可选；不传则只支持点遮罩恢复）
     */
    attach(inputId, veilId, btnId) {
        const input = $(inputId), veil = $(veilId), btn = btnId ? $(btnId) : null;
        if (!input || !veil) return null;

        this._setHidden(veil, true);
        // 点遮罩 = 恢复显示（与按钮互补：按钮切换，遮罩一键恢复）
        veil.addEventListener('click', () => this.hide(inputId));
        if (btn) btn.addEventListener('click', () => {
            this._map[inputId] && this._map[inputId].on ? this.hide(inputId) : this.show(inputId);
        });

        this._map[inputId] = { input, veil, btn, on: false, label: btn ? btn.textContent : '' };
        return this._map[inputId];
    },

    /* 同时设 hidden 属性与内联 display —— 缺一不可（见上方注释）。 */
    _setHidden(veil, hide) {
        veil.hidden = hide;
        veil.style.display = hide ? 'none' : 'flex';
    },

    /** 遮蔽（盖住输入框） */
    show(inputId) {
        const e = this._map[inputId];
        if (!e || e.on) return;
        const v = e.input.value || '';
        e.input.blur();                     // ① 先失焦：输入法收摊，此刻无 composition 在途
        e.input.setAttribute('readonly', ''); // ② 原生属性，不拦截任何事件
        e.veil.textContent = '●'.repeat(Math.min(Math.max(v.length, 1), 20)) +
            '　' + v.length + ' 字 · 点击显示';
        this._setHidden(e.veil, false);
        if (e.btn) e.btn.textContent = '👁 显示';
        e.on = true;
    },

    /** 解除遮蔽并聚焦 */
    hide(inputId) {
        const e = this._map[inputId];
        if (!e || !e.on) return;
        this._setHidden(e.veil, true);
        e.input.removeAttribute('readonly');
        e.input.focus();
        if (e.btn) e.btn.textContent = e.label || '🙈 遮蔽';
        e.on = false;
    },

    isOn(inputId) { return !!(this._map[inputId] && this._map[inputId].on); }
};

// ─── 汉字密文编解码器 (HanziCodec v2) ───
// 2048 字库 = 1792 常用汉字（GB2312一级字按字频排序）+ 256 常用符号
//    字库来自 src/hanzi-table-v2.js（由 tools/gen-hanzi-table.py 生成，勿手改）
// 每汉字承载 11 bit，周期 88 bit：8 个汉字精确编码 11 字节，无位浪费
//
// ⚠️ v2 与旧版 4096 字库**不兼容**：旧密文无法解码（按需求，不做向下兼容）。
const HanziCodec = {
    /* 字库（从 hanzi-table-v2.js 取）
     *
     * 该文件是可选依赖：只有需要汉字密文的页面（text-crypto / symmetric）
     * 才引入它。其余页面（签名、图片、PQ 等）虽然也加载 core.js，但从不调用
     * 汉字编解码 —— 所以字库缺失时**不能抛错**，否则会连带打断整页脚本。
     * 一旦真正调用 encode/decode，则由 _need() 抛出明确错误。
     */
    _table() {
        const t = (typeof window !== 'undefined' ? window : globalThis).HANZI_TABLE_V2;
        return t || null;
    },
    get ALPHABET() { return this._table() ? this._table().ALPHABET : null; },
    BITS: 11,
    SIZE: 2048,
    CHAR_MAP: null,
    _ok: false,          // 字库是否可用

    /* 真正要用字库时调用：缺失则报明确错误 */
    _need() {
        if (!this._ok) throw '字库未加载：本页未引入 hanzi-table-v2.js，无法使用汉字密文';
    },

    INIT() {
        const t = this._table();
        if (!t) { this._ok = false; this.CHAR_MAP = null; return; }
        this.CHAR_MAP = new Map();
        for (let i = 0; i < t.ALPHABET.length; i++) {
            this.CHAR_MAP.set(t.ALPHABET[i], i);
        }
        this._ok = true;
    },

    // Uint8Array → 汉字密文字符串
    //
    // 位累加器实现：以「字节流进、11bit 出」的方式流式产出，
    // 不构造巨型二进制字符串（旧版对大消息会产生 O(n) 字符串并拖慢编码）。
    // 输出长度 = ceil(n*8/11)，尾部用 0 填充至 11bit 边界。
    encode(bytes) {
        if (!this.CHAR_MAP) this.INIT();
        this._need();
        const A = this.ALPHABET;
        const src = new Uint8Array(bytes);
        const len = src.length;
        let out = '';
        let acc = 0, nbits = 0;              // acc 低位对齐，累计 nbits 位

        // 头部：1 字节标志 + 4 字节大端原始长度
        //
        // 为什么必须有长度头（这是 v1 就做的事，重构时误删导致严重 bug）：
        //   11bit/字 与 8bit/字节 不同步，编码尾部要补 0 到 11bit 边界。
        //   若解码方不知道原始字节数，就只能把残位当作完整字节输出 ——
        //   实测长度 1..3000 中有 27.3% 会多出 1 个字节，
        //   该多余字节会污染密文，表现为「认证失败：内容可能已被篡改」。
        //   长度写进**位流**（而非独立字节），因此不额外增加字符数。
        const head = [0x43, (len >>> 24) & 0xFF, (len >>> 16) & 0xFF, (len >>> 8) & 0xFF, len & 0xFF];
        for (let i = 0; i < head.length; i++) {
            acc = (acc << 8) | head[i];
            nbits += 8;
            while (nbits >= 11) {
                nbits -= 11;
                out += A[(acc >>> nbits) & 0x7FF];
            }
            acc &= (1 << nbits) - 1;
        }

        for (let i = 0; i < src.length; i++) {
            acc = (acc << 8) | src[i];       // 追加 1 字节
            nbits += 8;
            while (nbits >= 11) {
                nbits -= 11;
                out += A[(acc >>> nbits) & 0x7FF];
            }
            // 防止 acc 无限增长：只保留未消费的低位
            acc &= (1 << nbits) - 1;
        }
        if (nbits > 0) out += A[(acc << (11 - nbits)) & 0x7FF];   // 尾位补 0
        return out;
    },

    // 汉字密文字符串 → Uint8Array
    //
    // 与 encode 对称的位累加器，并按长度头精确裁掉尾部补位。
    decode(str) {
        if (!this.CHAR_MAP) this.INIT();
        this._need();
        // 兼容 emoji 等多码元：用 for...of 按码点遍历
        let acc = 0, nbits = 0;
        const bytes = [];
        for (const ch of str) {
            const idx = this.CHAR_MAP.get(ch);
            if (idx === undefined) throw '未知汉字字符: ' + ch;
            acc = (acc << 11) | idx;
            nbits += 11;
            while (nbits >= 8) {
                nbits -= 8;
                bytes.push((acc >>> nbits) & 0xFF);
            }
            acc &= (1 << nbits) - 1;
        }
        if (bytes.length < 5) throw '密文数据过短';
        if (bytes[0] !== 0x43) throw '密文头部标识异常（不是本工具生成的汉字密文）';
        const origLen = ((bytes[1] << 24) | (bytes[2] << 16) | (bytes[3] << 8) | bytes[4]) >>> 0;
        if (origLen > bytes.length - 5) {
            throw '密文长度头异常（声明 ' + origLen + ' 字节，实际仅 ' + (bytes.length - 5) + ' 字节）';
        }
        // 按长度头精确截取，丢弃编码时为对齐补入的尾部位
        return new Uint8Array(bytes.slice(5, 5 + origLen));
    },

    // 判断输入是否为汉字密文
    //
    // 判据：密文**全部**字符必然来自字库（编码即查表），命中率恒为 100%。
    // 而自然中文句子必然含字库外字（字库只有 1792 常用字 + 256 符号，
    // 实测日常句子命中率 82%~96%），故无容错余量可用。
    //
    // 旧版「前 6 字 80% 命中」在 4096 表下勉强可用，但表缩到 2048 后
    // 中文句子的命中率反而升高，必须改为全串严格判定 + 结构排除。
    isHanzi(str) {
        if (!str) return false;
        if (!this.CHAR_MAP) this.INIT();
        if (!this._ok) return false;      // 无字库的页面一律判定为非汉字密文
        const s = String(str).replace(/\s+/g, '');
        // 至少 8 字才够 11 字节（11bit*8 = 88bit = 11B）
        if (s.length < 8) return false;
        // 结构排除：Base64 一律不是汉字密文
        if (/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return false;
        // 全串判定：任一字符不在字库内即判定不是汉字密文
        for (const ch of s) {
            if (!this.CHAR_MAP.has(ch)) return false;
        }
        return true;
    }
};
HanziCodec.INIT();
