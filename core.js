window.addEventListener('error', (e) => {
    T('异常: ' + (e.error?.message || e.message || '脚本错误'));
});
window.addEventListener('unhandledrejection', (e) => {
    T('异常: ' + (e.reason?.message || e.reason || '未知错误'));
});

const $ = (i) => document.getElementById(i);

// 动态注入全局 Toast 和 Modal
document.addEventListener("DOMContentLoaded", () => {
    if (!$('tst')) {
        let t = document.createElement('div'); t.id = 'tst'; document.body.appendChild(t);
    }
    if (!$('pop')) {
        let p = document.createElement('div'); p.id = 'pop';
        p.innerHTML = `<div class="pbox"><div class="ht">📝 手动复制数据</div><textarea id="ptx" style="height:150px;margin-bottom:10px"></textarea><button class="btn" onclick="document.getElementById('pop').classList.remove('on')">关闭</button></div>`;
        document.body.appendChild(p);
    }
});

const T = (m) => { 
    let t = $('tst'); if (!t) return; 
    t.innerText = m; t.className = 'on'; 
    clearTimeout(t.tm); t.tm = setTimeout(() => t.className = '', 2000);
};

const CP = (i, isId) => {
    let el = $(i);
    let t = isId ? (el.value || el.innerText) : i;
    if (!t) return;
    if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(t).then(() => T("已复制")).catch(() => fallbackCP(t));
    } else {
        fallbackCP(t);
    }
};

const fallbackCP = (t) => {
    let p = $('pop'), x = $('ptx');
    if (p && x) { x.value = t; p.classList.add('on'); x.select(); T("请手动复制"); }
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
