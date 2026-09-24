window.addEventListener('error', (e) => {
    T('异常: ' + (e.error?.message || e.message || '脚本错误'));
});
window.addEventListener('unhandledrejection', (e) => {
    T('异常: ' + (e.reason?.message || e.reason || '未知错误'));
});

const $ = (i) => document.getElementById(i);

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
        let out = '';
        let acc = 0, nbits = 0;              // acc 低位对齐，累计 nbits 位
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
    // 与 encode 对称的位累加器。注意：11bit 与 8bit 的边界会产生
    // 「尾部不足一字节」的残位，残位必须丢弃（encode 时补的 0）。
    // 调用方需自持长度信息（本版由外层线格式承载，不再内嵌长度头）。
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
        // 尾部残位（<8bit）为编码时补零，直接丢弃
        return new Uint8Array(bytes);
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
