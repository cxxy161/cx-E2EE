/* ═══════════════════════════════════════════════════════════════════
 * 语言隐写 · UI 与基础交互层
 * ═══════════════════════════════════════════════════════════════════
 *
 * 职责边界（严格）：
 *   本文件只管 DOM 与交互状态机 —— 模式互斥 / 模型按钮与下载进度 /
 *   容量预估 / 两步流程 / 序列化进度与速度 / 取消 / 错误分流。
 *   **不含任何编解码算法**：位流、区间编码与推理循环在 Stego.* 里；
 *   段信封、排版分段与容量系数在 StegoTransport 里。
 *
 * ── 两步流程（仅语言隐写模式） ──
 *   ① 点既有「执行加密」→ 产出 Base64 → 进第一个输出框（#tct）
 *   ② 点新增「生成伪装文本」→ 序列化 → 进第二个输出框（#stt）
 *   汉字/Base64 模式保持一步出结果，因此 hz-seg / seg-loop 等既有测试不受影响。
 *
 * ── 期望的 Stego 接口（算法层） ──
 *   Stego.encodeBytes(cipherBytes, { signal, onProgress })
 *       -> { text, chars, chunks, sizes, steps, ms, ver }
 *   Stego.decodeText(text, { signal, onProgress }) -> { bytes, chunks, ver, legacy }
 */
(function (global) {
    'use strict';

    const $ = (i) => document.getElementById(i);

    /* ── 协议常量（与 src/stego.js / stego-transport.js 必须一致） ── */
    const C = {
        /* 排版上限来自传输层（单一真源），此处只做引用 */
        get SEG_CHAR_LIMIT() { return TR().SEG_CHAR_LIMIT; },
    };

    /** 传输层句柄（缺失时退化为最小实现，保证页面不炸） */
    function TR() {
        return global.StegoTransport || {
            SEG_CHAR_LIMIT: 2000, CHARS_PER_BYTE: 2.15,
            estimate: (n) => {
                const S = global.Stego;
                const cm = (S && S.CHUNK_MAX) || 256;
                const chunks = Math.max(1, Math.ceil(Math.max(0, n) / cm));
                const chars = Math.ceil((Math.max(0, n) + 2 * chunks) * 2.15);
                return { payloadBytes: n, chunks, bytesWithHead: n + 2 * chunks, chars, segs: Math.max(1, Math.ceil(chars / 1984)) };
            },
            estimateFromPlain: (p) => TR().estimate(p),
            b64Bytes: (b64) => Math.floor(String(b64 || '').replace(/\s+/g, '').length * 3 / 4),
        };
    }

    /** 每块明文上限（用于进度预估；真值在 Stego.CHUNK_MAX） */
    function chunkMax() {
        const S = global.Stego;
        return (S && S.CHUNK_MAX) || 256;
    }
    C.chunkMax = chunkMax;

    const fmt = {
        n: (x) => x.toLocaleString('zh-CN'),
        mb: (b) => (b / 1048576).toFixed(2) + ' MB',
        bps: (b) => b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB/s'
            : b >= 1024 ? (b / 1024).toFixed(0) + ' KB/s' : Math.round(b) + ' B/s',
        tok: (t) => t >= 1000 ? (t / 1000).toFixed(1) + 'k tok/s' : Math.round(t) + ' tok/s',
        sec: (ms) => {
            if (!isFinite(ms) || ms < 0) return '—';
            const s = Math.ceil(ms / 1000);
            if (s < 60) return s + ' 秒';
            const m = Math.floor(s / 60);
            return m + ' 分 ' + (s % 60) + ' 秒';
        },
    };

    const StegoUI = {
        /* ── 状态 ── */
        enabled: false,          // 语言隐写模式是否开启
        model: 'unknown',        // unknown|checking|missing|downloading|ready|error
        modelMsg: '',
        base64: '',              // 步骤①产物
        bodyText: '',            // 步骤②产物：**纯正文**（无段头），供「复制全文」
        busy: false,
        decBusy: false,
        advOpen: false,
        _dl: null,               // 下载进度快照
        _op: null,               // 序列化进度快照
        _abort: null,

        /* ═══ 初始化 ═══ */
        init() {
            // 恢复上次开关状态（跨会话记忆）
            let st = false;
            try { st = localStorage.getItem('cx_stego') === '1'; } catch (e) { }
            if ($('st-t')) $('st-t').checked = st;
            this.enabled = st;
            /* 启动兜底：上次隐写是开着的 —— 汉字密文必须立刻关掉，
             * 不能等用户点一次「生成伪装文本」才发现密文是汉字。
             * （页面启动段已先做过一次，此处覆盖脚本单独调用 init 的情形） */
            if (st) this.forceHanziOff();

            // Codec：ver=3 滑窗为唯一路径，无档位可恢复
            if (global.Stego && global.Stego.applyRangeGeometry) global.Stego.applyRangeGeometry();

            // 高级设置展开态
            try {
                if (localStorage.getItem('cx_stego_adv') === '1') {
                    this.advOpen = true;
                    const bd = $('st-adv-bd'), c = $('st-adv-caret');
                    if (bd) bd.style.display = '';
                    if (c) c.innerText = '▾';
                }
            } catch (e) { }

            // 引擎状态回调
            if (global.StegoEngine) {
                global.StegoEngine.onState = (s, d) => { this.model = s; this.modelMsg = d; this.sync(); };
                global.StegoEngine.check().then(ok => { this.model = ok ? 'ready' : 'missing'; this.sync(); });
            } else {
                this.model = 'error'; this.modelMsg = '引擎脚本未加载';
            }
            this.sync();
        },

        /* ═══ 模式开关（互斥 + 纯模型模式） ═══ */
        onToggle() {
            const on = !!($('st-t') && $('st-t').checked);
            this.enabled = on;
            try { localStorage.setItem('cx_stego', on ? '1' : '0'); } catch (e) { }

            if (on) {
                // 纯模型模式：汉字开关强制关闭且整行不可用（不再互斥提示）
                this.forceHanziOff();
                T('已开启语言隐写：加解密将使用模型模式');
            } else {
                T('已关闭语言隐写');
            }
            /* 分段开关**不因隐写而锁定**：分段只是发送排版，
             * 与是否用模型无关 —— 用户可能用微信/邮件/论坛，不是只有 QQ。
             * 隐写模式下同样尊重用户的开关选择。 */
            this.sync();
        },

        /* ═══ 汉字密文的唯一权威关闭点（互斥硬闸） ═══
         *
         * 为什么必须有一个**幂等的强制关闭**，而不是只在 onToggle 里关一次：
         *   隐写模式要求密文是 Base64（步骤② Util.b642buf 只吃 Base64）。
         *   汉字开关整行只是 `display:none` —— 隐藏 ≠ 禁用：
         *     · 刷新时 localStorage 的 cx_hz='1' 会把 checked 回填成 true
         *       （text-crypto.html 启动段曾无条件恢复，这是本 bug 的根因）；
         *     · 脚本赋值 / 无障碍操作也能在隐藏状态下把 checked 置回 true。
         *   两种路径都会让「执行加密」产出汉字密文，然后步骤②抛
         *   「密文不是有效 Base64」—— 用户完全无从理解。
         *
         * 所以：**任何非 Base64 选项都必须被无条件、可重复地清掉**，
         * 并且把持久化值一并改回 '0'，让矛盾态不会跨会话存活。
         * 调用点：onToggle（开）· init（启动兜底）· TA.onHz（页面侧二次防御）。
         */
        forceHanziOff() {
            const t = $('hz-t');
            if (t && t.checked) t.checked = false;
            // 持久化同步归零，否则下次刷新又会把 checked 回填成 true
            try { localStorage.setItem('cx_hz', '0'); } catch (e) { }
            // 标签文案可能停在「开启」，同步刷新
            try { if (typeof TA !== 'undefined' && TA.onHzSilent) TA.onHzSilent(); } catch (e) { }
            // 隐藏的整行同时标 disabled + aria-hidden，让脚本/无障碍路径也改不动
            const row = $('hz-row');
            if (row) { row.setAttribute('aria-hidden', 'true'); }
            if (t) t.disabled = true;
            return true;
        },

        /** 退出隐写模式时恢复汉字开关的可用性（勾选状态不自动恢复） */
        releaseHanzi() {
            const t = $('hz-t');
            if (t) t.disabled = false;
            const row = $('hz-row');
            if (row) row.removeAttribute('aria-hidden');
        },

        /* ═══ 步骤①完成：拿到 Base64 ═══ */
        onCipherReady(cipher) {
            this.base64 = cipher || '';
            // 新密文 → 清掉上一次的伪装文本与分段，避免误复制旧结果
            this.bodyText = '';
            this._segTexts = null;
            const out = $('st-out'); if (out) out.classList.remove('on');
            const segs = $('st-segs'); if (segs) { segs.innerHTML = ''; segs.style.display = 'none'; }
            const cap = $('st-cap'); if (cap) { cap.className = 'cap'; cap.innerText = ''; }
            const t = $('stt'); if (t) t.innerText = '';
            this.sync();
        },

        /* ═══ 高级设置 ═══ */
        toggleAdv() {
            this.advOpen = !this.advOpen;
            const bd = $('st-adv-bd'), c = $('st-adv-caret');
            if (bd) bd.style.display = this.advOpen ? '' : 'none';
            if (c) c.innerText = this.advOpen ? '▾' : '▸';
            try { localStorage.setItem('cx_stego_adv', this.advOpen ? '1' : '0'); } catch (e) { }
        },

        toggleInfo(e) {
            if (e && e.stopPropagation) e.stopPropagation();
            const p = $('st-i-pop');
            if (p) p.style.display = (p.style.display === 'none' || !p.style.display) ? '' : 'none';
        },

        /** 档位控件已随 ver=2 移除（区间编码下候选池是常数，无压缩↔通顺权衡）。
         *  保留空实现以兼容可能残留的旧 DOM 引用。 */
        onTopkInput() { },
        onTopkCommit() { },
        _syncSlider() { },

        /* ═══ 复制输出（必须带段信封，否则接收端无法识别） ═══ */
        copyOutput(btn) {
            const wire = this.wireText();
            if (!wire) return T('还没有可复制的内容');
            this._copy(wire, btn, '伪装文本');
        },

        /* ═══ 两步解密：步骤① 还原为 Base64 ═══ */
        async decode() {
            if (this.decBusy) return;
            if (!this.enabled) return T('请先在「语言隐写」中启用');
            if (this.model !== 'ready') return T('模型未就绪，请先下载模型');

            const raw = ($('tci') && $('tci').value) || '';
            if (!raw.trim()) return T('请粘贴伪装文本');

            // 廉价预筛：明显不是词表文本的直接拒，不浪费推理
            if (global.Stego && global.Stego.prefilter) {
                const hit = global.Stego.prefilter(raw);
                if (hit < 0.85) {
                    return this._decMsg('err', '这段文本与词表字符集匹配度仅 ' +
                        Math.round(hit * 100) + '%，不像是隐写文本（未运行模型）');
                }
            }

            const btn = $('st-dec-go');
            this.decBusy = true;
            this._abort = new AbortController();
            UI.busy(btn, true, '⏳ 识别中…');
            const box = $('st-dec-prog'); if (box) box.style.display = '';
            const fill = $('st-dec-fill'); if (fill) fill.style.width = '0%';
            const t0 = Date.now();

            try {
                const r = await global.Stego.decodeText(raw, {
                    signal: this._abort.signal,
                    onProgress: (p) => this._renderDecProgress(p),
                });
                // 还原成 Base64 填回输入框，供「执行解密」使用
                const b64 = global.Util ? global.Util.buf2b64(r.bytes.buffer)
                    : btoa(String.fromCharCode.apply(null, new Uint8Array(r.bytes)));
                if ($('tci')) $('tci').value = b64;
                if (typeof TA !== 'undefined' && TA.onCipher) TA.onCipher();
                this._decMsg('ok', '✓ 已还原为 Base64 · ' + r.bytes.length + ' 字节 · ' +
                    (r.legacy ? '历史版本' : ('Codec v' + (r.ver || 3))) + ' · ' +
                    fmt.sec(Date.now() - t0) + '　→ 现在点「执行解密」');
                T('已还原为 Base64，请继续点「执行解密」');
            } catch (e) {
                if (e && e.name === 'AbortError') { this._decMsg('', '已取消'); }
                else if (e && e.code === 'INCOMPLETE') this._decMsg('err', e.message);
                else if (e && e.code === 'NOT_STEGO') this._decMsg('err', '这段内容不是隐写文本（模型已判定，未作修改）');
                else this._decMsg('err', '识别失败：' + (e && e.message ? e.message : e));
            } finally {
                this.decBusy = false;
                this._abort = null;
                UI.busy(btn, false);
                if (box) box.style.display = 'none';
            }
        },

        _decMsg(kind, text) {
            const el = $('st-dec-msg');
            if (!el) return;
            el.className = 'meta' + (kind === 'ok' ? ' st-ok-txt' : kind === 'err' ? ' st-err-txt' : '');
            el.innerText = text || '';
        },

        _renderDecProgress(p) {
            const fill = $('st-dec-fill'), meta = $('st-dec-meta'), pct = $('st-dec-pct');
            if (!fill) return;
            /* ⚠️ 进度必须以**全局字符数**为分子。
             * 原实现分子是「本段内已解 token」、分母是「全消息 token」，
             * 于是每解完一段分子就归零重来 —— 用户看到进度条跳回 0。
             * 现在按 chars/charsTotal 计算，天然单调递增。 */
            const pctv = p.charsTotal ? Math.min(100, p.chars / p.charsTotal * 100) : 0;
            fill.style.width = pctv.toFixed(1) + '%';
            if (pct) pct.innerText = pctv.toFixed(0) + '%';
            if (meta) {
                const parts = [];
                if (p.chunks) parts.push('已解 ' + p.chunks + ' 块');
                if (p.charsTotal) parts.push(fmt.n(p.chars) + '/' + fmt.n(p.charsTotal) + ' 字符');
                meta.innerText = parts.join(' · ') || '识别中…';
            }
        },
        /** 容量预估（纯线性，单调）。
         *
         *  公式：字数 ≈ (PayloadBytes + 2 × 块数) × 2.15
         *  真实实现与分段规则都在 StegoTransport（传输层），此处只做展示。
         *
         *  ⚠️ 已废弃旧阶梯：帧数 = ceil(密文/284)、字数 = 帧数 × 624
         *     —— 那样会有阶梯跳跃，且短消息因固定开销被显著虚高。 */
        estimate(cipherBytes) {
            return TR().estimate(cipherBytes || 0);
        },

        _renderEstimate() {
            const el = $('st-est');
            if (!el) return;
            if (!this.enabled) { el.innerText = ''; return; }

            const plain = ($('tpt') && $('tpt').value) || '';
            const plainBytes = new TextEncoder().encode(plain).length;
            const has = !!this.base64;
            const TRl = TR();
            /* 有密文：按**实际**载荷字节算（精确）。
             * 只有明文：按 明文 + 加密层注入的开销 估（overhead 未注册则为 0）。 */
            const e = has
                ? TRl.estimate(TRl.b64Bytes(this.base64))
                : (plainBytes ? TRl.estimateFromPlain(plainBytes) : null);

            if (!e || !e.payloadBytes) {
                el.innerHTML = '<span class="st-dim">输入明文后显示容量预估</span>';
                return;
            }

            /* ── 膨胀率 = 隐写字符数 ÷ **原文字符数** ──
             * ⚠️ 量纲必须一致：左边曾是"字当字节"（×3）、右边是字节 ⇒ 虚高 3 倍；
             *    且明文框清空时 Math.max(1,0) 造出 1 字节分母 ⇒ 1872x 那种离谱数字。
             *    现在两边都按**字符**算，明文未知时干脆不显示倍率。 */
            const plainChars = Array.from(plain).length;
            const ratio = plainChars > 0 ? (e.chars / plainChars).toFixed(1) : '';
            const cyBytes = e.payloadBytes;

            let h = '密文 <b>' + fmt.n(cyBytes) + '</b> 字节 → 伪装文本约 <b>' +
                fmt.n(e.chars) + '</b> 字';
            if (e.segs > 1) h += '（分 <b>' + e.segs + '</b> 段）';
            if (ratio) h += '<br>原文 ' + fmt.n(plainChars) + ' 字，膨胀 ' + ratio + 'x';
            if (!has) h += '<br><span class="st-dim">※ 基于预估；点「执行加密」后按实际密文重算</span>';
            if (e.segs > 1) {
                h += '<br><span class="st-dim">※ 每段 ≤ ' + fmt.n(TRl.SEG_CHAR_LIMIT) +
                    ' 字（长消息自动分段，便于按条发送）</span>';
            }

            el.innerHTML = h;
        },

        /* ═══ 模型下载 ═══ */
        async downloadModel() {
            const E = global.StegoEngine;
            if (!E) return T('引擎脚本未加载');
            const btn = $('st-dl');
            btn.disabled = true;

            const ok = await E.fetchModel({
                onProgress: (p) => {
                    this._dl = p;
                    this._renderDownload();
                },
            });

            btn.disabled = false;
            if (ok) {
                this.model = 'ready'; this.modelMsg = '';
                T('模型已下载并就绪');
            } else {
                this.model = E.state;
                this.modelMsg = E.detail;
                T(E.state === 'missing' ? '模型尚未部署到站点' : '下载失败');
            }
            this._dl = null;
            this.sync();
        },

        cancelDownload() {
            if (global.StegoEngine) global.StegoEngine.cancelDownload();
        },

        _renderDownload() {
            const p = this._dl;
            const bar = $('st-dl-bar'), fill = $('st-dl-fill'), meta = $('st-dl-meta');
            if (!p || !bar) return;
            bar.style.display = '';
            const pct = p.total ? Math.min(100, p.got / p.total * 100) : 0;
            fill.style.width = pct.toFixed(1) + '%';
            meta.innerText = p.file + ' · ' + fmt.mb(p.got) + (p.total ? ' / ' + fmt.mb(p.total) : '') +
                ' · ' + fmt.bps(p.bps) + (p.total ? ' · ' + pct.toFixed(0) + '%' : '');
        },

        /* ═══ 步骤②：序列化 ═══ */
        async generate() {
            if (this.busy) return;
            if (!this.base64) return T('请先点「执行加密」生成密文');
            if (this.model !== 'ready') return T('模型未就绪');

            const S = global.Stego;
            if (!S || typeof S.encodeBytes !== 'function') {
                return T('序列化内核尚未接入（等模型交付）');
            }

            const btn = $('st-go');
            this.busy = true;
            this._abort = new AbortController();
            UI.busy(btn, true, '⏳ 序列化中…');
            const box = $('st-prog'); if (box) box.style.display = '';
            const fill0 = $('st-prog-fill'); if (fill0) fill0.style.width = '0%';
            const pct0 = $('st-prog-pct'); if (pct0) pct0.innerText = '0%';
            const meta0 = $('st-prog-meta'); if (meta0) meta0.innerText = '准备中…';
            const t0 = Date.now();

            try {
                const bytes = Util.b642buf(this.base64);
                if (!bytes) throw new Error('密文不是有效 Base64');

                /* Codec 只吐纯正文；分段与段信封是**传输层**职责。 */
                const r = await S.encodeBytes(new Uint8Array(bytes), {
                    signal: this._abort.signal,
                    onProgress: (p) => this._renderProgress(p, t0),
                });
                const seg = TR().segmentText(r.text, Math.random().toString(36).slice(2, 6));

                this.renderSegments({ segments: seg.segments, chars: r.chars });
                const cap = $('st-cap');
                if (cap) {
                    cap.className = 'cap ok';
                    cap.innerText = '✓ 伪装文本已生成 · ' + seg.segs + ' 段 · ' +
                        fmt.n(r.chars) + ' 字 · ' + r.chunks + ' 块 · ' + fmt.sec(Date.now() - t0);
                }
                const fillEnd = $('st-prog-fill'); if (fillEnd) fillEnd.style.width = '100%';
                const pctEnd = $('st-prog-pct'); if (pctEnd) pctEnd.innerText = '100%';
                const out = $('st-out');
                if (out) { out.classList.add('on'); UI.reveal(out); }
                T(seg.segs > 1 ? '生成完成，按段复制发送' : '生成完成，复制全文即可发送');
            } catch (e) {
                if (e && e.name === 'AbortError') {
                    T('已取消序列化');
                } else {
                    const cap = $('st-cap');
                    if (cap) { cap.className = 'cap err'; cap.innerText = '✕ ' + (e && e.message ? e.message : e); }
                    const out = $('st-out');
                    if (out) { out.classList.add('on'); UI.reveal(out); }
                }
            } finally {
                this.busy = false;
                this._abort = null;
                UI.busy(btn, false);
                if (box) box.style.display = 'none';
                this.sync();
            }
        },

        cancel() {
            if (this._abort) this._abort.abort();
        },

        _renderProgress(p, t0) {
            const fill = $('st-prog-fill'), meta = $('st-prog-meta');
            if (!fill) return;
            const pct = p.stepsTotal ? Math.min(100, p.step / p.stepsTotal * 100) : 0;
            fill.style.width = pct.toFixed(1) + '%';
            this._op = p;

            // 首次回调先让进度条可见（否则要等一个时间片才出现，观感像卡住）
            const box = $('st-prog');
            if (box && box.style.display === 'none') box.style.display = '';

            const parts = [];
            if (p.chunks) parts.push('第 ' + p.chunks + ' 块');
            if (p.step) parts.push(fmt.n(p.step) + ' token');
            if (p.bps) parts.push(fmt.tok(p.bps));
            if (p.etaMs != null && isFinite(p.etaMs)) parts.push('剩余 ' + fmt.sec(p.etaMs));
            if (meta) meta.innerText = parts.join(' · ') || '序列化中…';

            const pctEl = $('st-prog-pct');
            if (pctEl) pctEl.innerText = pct.toFixed(0) + '%';
        },

        /* ═══ 输出渲染 ═══
         *
         * 三条输出通道，**互不污染**（这正是之前 bug 的核心）：
         *   ① 主输出框 #stt /「复制全文」→ **纯正文**，一个段头都不带
         *      （段头只是排版标识，解码并不需要它；见 stego.js:mergeSegments）
         *   ② 分段列表里的「复制本段」→ 带段头（方便按段发送 + 接收端归位）
         *   ③ 分段列表里的「复制全部 N 段」→ 每段带段头（保留分段结构）
         *
         * 原实现把带段头的文本塞进 _segTexts 并让「复制全文」也用它，
         * 于是"全文"里混进了 CX2|1/2|… 段头 —— 用户看到的正是这个。
         */
        renderSegments(r) {
            const box = $('st-segs');
            const out = $('stt');
            if (!box) return;
            const segs = r.segments || [];
            this.bodyText = segs.map(s => s.body).join('');
            if (out) out.innerText = this.bodyText;

            /* 带段头的线上文本（仅用于「复制本段 / 复制全部」）——
             * 信封格式由传输层唯一实现，UI 不再自己拼字符串。 */
            this._segTexts = TR().wires(segs);

            if (segs.length <= 1) { box.innerHTML = ''; box.style.display = 'none'; return; }

            let h = '<div class="seg-hd">✂ 已分为 <b>' + segs.length + '</b> 段（每段 ≤ ' +
                fmt.n(C.SEG_CHAR_LIMIT) + ' 字，适配 QQ 单条上限）。' +
                '<b>接收方把全部段一起粘贴即可解密，顺序不限</b>；' +
                '若只发全文，不带段头也能解。' +
                '<button class="seg-cp seg-all" type="button" data-all="1" style="margin-left:8px">📋 复制全部 ' +
                segs.length + ' 段</button></div>';
            this._segTexts.forEach((withHead, i) => {
                h += '<div class="seg-item">' +
                    '<span class="seg-no">第 ' + (i + 1) + ' 段 / ' + segs.length + '</span>' +
                    '<span class="seg-len">' + withHead.length + ' 字符</span>' +
                    '<button class="seg-cp" type="button" data-seg="' + i + '">📋 复制本段</button>' +
                    '</div>' +
                    '<textarea class="seg-tx" readonly data-i="' + i + '">' + this._esc(withHead) + '</textarea>';
            });
            box.innerHTML = h;
            box.style.display = '';

            box.querySelectorAll('[data-seg]').forEach(b => {
                b.onclick = () => {
                    const i = parseInt(b.dataset.seg, 10);
                    this._copy(this._segTexts[i], b, '第 ' + (i + 1) + ' 段');
                };
            });
            const allBtn = box.querySelector('[data-all]');
            if (allBtn) allBtn.onclick = () => this._copy(this._segTexts.join('\n\n'), allBtn, '全部 ' + segs.length + ' 段');
        },

        /** 「复制全文」= 纯正文（无段头）。带段头的走分段列表里的按钮。 */
        wireText() {
            return this.bodyText || '';
        },

        _esc(s) {
            return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        },

        _copy(text, btn, label) {
            const done = () => {
                const old = btn.textContent;
                btn.textContent = '✓ 已复制'; btn.classList.add('done');
                setTimeout(() => { btn.textContent = old; btn.classList.remove('done'); }, 1400);
                T((label || '') + '已复制');
            };
            if (navigator.clipboard && window.isSecureContext) {
                navigator.clipboard.writeText(text).then(done).catch(() => T('自动复制被浏览器拦截，请手动选中复制'));
                return;
            }
            try {
                const ta = document.createElement('textarea');
                ta.value = text; document.body.appendChild(ta); ta.select();
                document.execCommand('copy'); ta.remove(); done();
            } catch (e) { T('请手动选中内容复制'); }
        },

        /* ═══ 统一同步控件状态 ═══ */
        sync() {
            const panel = $('st-panel');
            if (panel) panel.style.display = this.enabled ? '' : 'none';

            const tag = $('st-tag');
            if (tag) tag.innerText = this.enabled ? '实验' : '关闭';

            // 模型状态
            const st = $('st-model-state'), dl = $('st-dl');
            if (st) {
                const map = {
                    unknown: ['未知', 'st-dim'], checking: ['检查中…', 'st-dim'],
                    missing: ['未下载', 'st-dim'], downloading: ['下载中…', 'st-dim'],
                    ready: ['✓ 已就绪', 'st-ok'], error: ['✕ ' + (this.modelMsg || '错误'), 'st-err'],
                };
                const [txt, cls] = map[this.model] || map.unknown;
                st.innerText = txt;
                st.className = 'st-state ' + cls;
            }
            if (dl) {
                dl.disabled = this.model === 'downloading' || this.model === 'ready';
                dl.textContent = this.model === 'ready' ? '✓ 模型已缓存'
                    : this.model === 'downloading' ? '⏳ 下载中…'
                        : this.model === 'error' ? '↻ 重试下载' : '⬇ 下载模型（待部署）';
            }
            if ($('st-dl-bar')) $('st-dl-bar').style.display = this.model === 'downloading' ? '' : 'none';

            // 步骤②按钮：需要 ①密文 + ②模型就绪
            const go = $('st-go');
            if (go) {
                go.disabled = this.busy || !this.base64 || this.model !== 'ready';
                go.title = !this.base64 ? '请先点「执行加密」生成密文'
                    : this.model !== 'ready' ? '模型未就绪' : '';
            }
            // 步骤②只在语言隐写模式下出现（汉字/Base64 保持一步出结果，
            // 既有测试 hz-seg / seg-loop 依赖「点一次加密就出结果」）
            const step2 = $('st-step2');
            if (step2) step2.style.display = this.enabled ? '' : 'none';
            if ($('st-cancel')) $('st-cancel').style.display = this.busy ? '' : 'none';

            // ── 纯模型模式：隐写开启时隐藏并强制关闭汉字开关整行 ──
            // 隐藏只是表观；**必须同时 forceHanziOff**，否则隐藏状态下被
            // 回填的 checked 仍会驱动 TA.enc() 产出汉字密文（本 bug 根因）。
            const hzRow = $('hz-row');
            if (hzRow) hzRow.style.display = this.enabled ? 'none' : '';
            if (this.enabled) this.forceHanziOff();
            else this.releaseHanzi();

            // ── 解密区步骤①（还原为 Base64）仅在隐写开启时出现 ──
            const dstep = $('st-dec-step');
            if (dstep) dstep.style.display = this.enabled ? '' : 'none';
            const dgo = $('st-dec-go');
            if (dgo) {
                dgo.disabled = this.decBusy || this.model !== 'ready';
                dgo.title = this.model !== 'ready' ? '模型未就绪' : '';
            }
            if ($('st-dec-cancel')) $('st-dec-cancel').style.display = this.decBusy ? '' : 'none';

            // 解密框占位文案随模式变化
            const tci = $('tci');
            if (tci) {
                tci.placeholder = this.enabled
                    ? '粘贴伪装文本（自然语言段落），点「还原为 Base64」'
                    : '粘贴收到的密文（Base64 或汉字密文，自动识别）';
            }

            this._renderEstimate();
        },
    };

    global.StegoUI = StegoUI;
    global.StegoConst = C;
})(typeof window !== 'undefined' ? window : globalThis);
