/**
 * detect-models.js — 检测模型（自动打框）的目录扫描 / 启动期转译 / 状态查询
 *
 * 设计要点（为什么这么写）
 * ------------------------
 * 1) 浏览器只会跑 ONNX，而拿到手的权重基本都是 Ultralytics 的 `.pt`。
 *    所以把「转译」交给 tools/detect-export.py，本模块只负责：什么时候转、转哪些、转到什么状态。
 * 2) **启动期转译不能阻塞 HTTP**：`app.listen` 之后异步跑，队列并发固定为 1
 *    （torch 导出是 CPU 密集型，并发只会互相拖慢），失败只影响那一个模型。
 * 3) **增量而非无条件重转**：判据是「源文件 sha256 + imgsz + opset 与 build/<id>.json 一致」。
 *    每次启动都全量重导会让启动白等 10~60 秒/模型；需要强制时用 CX_DETECT_FORCE=1。
 * 4) 产物一律落在 models/detect/build/，由 /detect-model/ 静态路由提供，并且**带缓存**
 *    —— 这与 ./server.js 里给 src/ 加的 no-store 是两码事：那边禁缓存是为了防
 *    「新页面 + 旧脚本」混搭，这边是几十 MB 的不可变二进制，每次重下纯属浪费。
 * 5) 缺 python / 缺 torch·ultralytics 时**整条功能降级**（available:false + hint），
 *    绝不影响加密、解密、公钥库等既有能力。
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const APP_ROOT = path.resolve(__dirname, '..');
// 模型目录默认在仓库里；部署时可以用 CX_DETECT_ROOT 指向挂载卷
// （镜像只 COPY server/ src/，所以容器里默认没有 models/ —— 见 docs/detect-auto-box.md 的部署一节）
const DETECT_ROOT = process.env.CX_DETECT_ROOT
    ? path.resolve(process.env.CX_DETECT_ROOT)
    : path.join(APP_ROOT, 'models', 'detect');
const BUILD_DIR = path.join(DETECT_ROOT, 'build');
const RUNTIME_DIR = path.join(APP_ROOT, 'src', 'vendor', 'ort');
const EXPORT_PY = path.join(APP_ROOT, 'tools', 'detect-export.py');

const KINDS = ['segm', 'bbox'];
const SRC_EXT = ['.pt', '.pth', '.onnx'];
const IMGSZ = Number(process.env.CX_DETECT_IMGSZ || 640);
const OPSET = Number(process.env.CX_DETECT_OPSET || 17);
const AUTOCONVERT = process.env.CX_DETECT_AUTOCONVERT !== '0';
const FORCE = process.env.CX_DETECT_FORCE === '1';
const TIMEOUT_MS = Number(process.env.CX_DETECT_TIMEOUT_MS || 10 * 60 * 1000);
const LOG_MAX = 60;

const state = {
    python: { ok: false, cmd: null, version: null, missing: [], hint: null, versions: {} },
    models: new Map(),          // id -> 模型条目
    pending: [],                // 待转译 id 队列
    running: null,              // 正在转译的 id
    stats: { done: 0, failed: 0 },
    logs: [],
    startedAt: null,
    scanning: false,
    dirError: null,
};

function log(msg) {
    const line = `[detect] ${msg}`;
    state.logs.push(line);
    if (state.logs.length > LOG_MAX) state.logs.shift();
    console.log(line);
}

/**
 * 建目录：**故意吞掉异常**。
 * 部署形态里可能有只读根文件系统 / 非 root 用户 / 未挂载卷 —— 那时候自动打框本来就该降级，
 * 但绝不能因此让整个站点起不来（本函数历史上跑在 listen 之后的异步流程里，
 * 一旦抛出会成为 unhandled rejection，Node 16+ 默认直接退出进程）。
 */
function ensureDirs() {
    try {
        fs.mkdirSync(BUILD_DIR, { recursive: true });
        for (const k of KINDS) fs.mkdirSync(path.join(DETECT_ROOT, k), { recursive: true });
        return true;
    } catch (e) {
        state.dirError = String((e && e.message) || e);
        log(`模型目录不可写（${DETECT_ROOT}）：${state.dirError} —— 自动打框将不可用，其余功能不受影响`);
        return false;
    }
}

/** 诊断脱敏：默认只回 basename，避免公网部署暴露服务器路径；排查时可开 CX_DETECT_EXPOSE_DIAG=1 */
const EXPOSE_DIAG = process.env.CX_DETECT_EXPOSE_DIAG === '1';
function maskPath(p) {
    if (!p || EXPOSE_DIAG) return p;
    return path.basename(String(p));
}
function maskLogLine(line) {
    if (EXPOSE_DIAG) return line;
    return String(line).replace(/[A-Za-z]:\\[^\s，,、）)]+|\/(?:home|app|root|mnt|opt|usr)\/[^\s，,、）)]+/g, (m) => path.basename(m));
}

function sha256File(p) {
    return new Promise((resolve, reject) => {
        const h = crypto.createHash('sha256');
        const s = fs.createReadStream(p);
        s.on('data', (d) => h.update(d));
        s.on('end', () => resolve(h.digest('hex')));
        s.on('error', reject);
    });
}

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/** 逐个试解释器，返回第一个能跑起来的（CX_PYTHON 优先） */
function resolvePython() {
    const cands = [process.env.CX_PYTHON, 'python3', 'python', 'py'].filter(Boolean);
    for (const cmd of cands) {
        const r = spawnSync(cmd, ['-V'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
        if (!r.error && r.status === 0) {
            return { cmd, version: (r.stdout || r.stderr || '').trim() };
        }
    }
    return null;
}

/** 依赖体检：直接问 export 脚本，它知道需要哪些包 */
function checkPython() {
    const py = resolvePython();
    if (!py) {
        state.python = {
            ok: false, cmd: null, version: null, missing: ['python'], versions: {}, hint:
                '找不到 python 解释器。设 CX_PYTHON 指向 ComfyUI 自带的 python，例如：' +
                'CX_PYTHON="D:\\ComfyUI-new\\venv\\Scripts\\python.exe"'
        };
        return state.python;
    }
    const r = spawnSync(py.cmd, [EXPORT_PY, '--check'], {
        encoding: 'utf8', windowsHide: true, timeout: 120000, cwd: APP_ROOT, maxBuffer: 4 << 20,
    });
    let parsed = null;
    for (const line of String(r.stdout || '').split(/\r?\n/)) {
        if (line.startsWith('CXEXPORT ')) {
            try { parsed = JSON.parse(line.slice('CXEXPORT '.length)); } catch (e) { /* ignore */ }
        }
    }
    if (!parsed) {
        state.python = {
            ok: false, cmd: py.cmd, version: py.version, missing: ['unknown'], versions: {},
            hint: '依赖体检未通过：' + String(r.stderr || r.stdout || r.error || '').trim().slice(-400)
        };
        return state.python;
    }
    state.python = {
        ok: !!parsed.ok, cmd: py.cmd, version: py.version, versions: parsed.versions || {},
        missing: parsed.missing || [], hint: parsed.ok ? null :
            ('缺少 python 依赖：' + (parsed.missing || []).join(', ') +
                '。可用 ComfyUI 自带的 python（CX_PYTHON）或 pip 安装 ultralytics onnxruntime torch。')
    };
    return state.python;
}

/** 扫描 segm/ 与 bbox/：返回源文件列表 */
function listSources() {
    const out = [];
    for (const kind of KINDS) {
        const dir = path.join(DETECT_ROOT, kind);
        if (!fs.existsSync(dir)) continue;
        for (const name of fs.readdirSync(dir).sort()) {
            const ext = path.extname(name).toLowerCase();
            if (!SRC_EXT.includes(ext)) continue;
            const src = path.join(dir, name);
            let st;
            try { st = fs.statSync(src); } catch (e) { continue; }
            if (!st.isFile()) continue;
            out.push({ id: path.basename(name, path.extname(name)), kind, src, ext, bytes: st.size, mtime: st.mtimeMs });
        }
    }
    return out;
}

async function scanAndEnqueue({ force = FORCE } = {}) {
    state.scanning = true;
    ensureDirs();
    const sources = listSources();
    const seen = new Set();
    for (const s of sources) {
        seen.add(s.id);
        const metaP = path.join(BUILD_DIR, s.id + '.json');
        const meta = readJson(metaP);
        let fresh = false;
        if (!force && meta && meta.source && meta.imgsz === IMGSZ && meta.opset === OPSET) {
            try { fresh = (meta.source.sha256 === await sha256File(s.src)); } catch (e) { fresh = false; }
        }
        const prev = state.models.get(s.id) || {};
        const entry = Object.assign({}, prev, {
            id: s.id, kind: s.kind, source: { file: path.basename(s.src), bytes: s.bytes },
            task: (meta && meta.task) || (s.kind === 'segm' ? 'segment' : 'detect'),
            classes: (meta && meta.classes) || {}, imgsz: (meta && meta.imgsz) || IMGSZ,
            files: (meta && meta.files) || {},
            status: fresh ? 'ready' : 'pending',
            error: fresh ? null : prev.error,
        });
        if (fresh) entry.ms = meta.ms;
        state.models.set(s.id, entry);
        if (!fresh && !state.pending.includes(s.id) && state.running !== s.id) state.pending.push(s.id);
    }
    // build 里存在但源已被删除的模型：保留可服务（页面仍能选），只是不再参与扫描
    for (const id of [...state.models.keys()]) {
        if (!seen.has(id) && !fs.existsSync(path.join(BUILD_DIR, id + '.json'))) state.models.delete(id);
    }
    state.scanning = false;
    log(`扫描完成：源 ${sources.length} 个，待转译 ${state.pending.length} 个` +
        (state.python.ok ? '' : '（python 依赖不可用，转译跳过）'));
    return sources;
}

function convertOne(id) {
    const m = state.models.get(id);
    if (!m) return Promise.resolve();
    const src = path.join(DETECT_ROOT, m.kind, m.source.file);
    if (!fs.existsSync(src)) {
        m.status = 'error'; m.error = '源文件不存在'; return Promise.resolve();
    }
    m.status = 'converting'; m.error = null;
    state.running = id;
    const args = [EXPORT_PY, '--src', src, '--kind', m.kind, '--out', BUILD_DIR,
        '--imgsz', String(IMGSZ), '--opset', String(OPSET)];
    if (FORCE) args.push('--force');
    log(`开始转译 ${id}（${m.source.file}，${(m.source.bytes / 1048576).toFixed(1)} MB）`);
    const t0 = Date.now();
    return new Promise((resolve) => {
        const ch = spawn(state.python.cmd, args, { cwd: APP_ROOT, windowsHide: true });
        let out = '', err = '';
        const timer = setTimeout(() => {
            err += `\n超时 ${Math.round(TIMEOUT_MS / 1000)}s，已终止`;
            ch.kill('SIGKILL');
        }, TIMEOUT_MS);
        ch.stdout.on('data', (d) => { out += d.toString(); });
        ch.stderr.on('data', (d) => { err += d.toString(); });
        ch.on('close', (code) => {
            clearTimeout(timer);
            state.running = null;
            let meta = null;
            for (const line of out.split(/\r?\n/)) {
                if (line.startsWith('CXEXPORT ')) { try { meta = JSON.parse(line.slice(9)); } catch (e) { } }
            }
            if (code === 0 && meta && meta.files && meta.files.fp32) {
                Object.assign(m, {
                    status: 'ready', error: null, files: meta.files, classes: meta.classes || {},
                    task: meta.task || m.task, imgsz: meta.imgsz, ms: meta.ms || (Date.now() - t0),
                });
                state.stats.done++;
                log(`转译完成 ${id}：fp32 ${(meta.files.fp32.bytes / 1048576).toFixed(1)} MB` +
                    (meta.files.int8 ? ` / int8 ${(meta.files.int8.bytes / 1048576).toFixed(1)} MB` : '') +
                    `，${((Date.now() - t0) / 1000).toFixed(1)} s`);
            } else {
                m.status = 'error';
                m.error = (err || out || `退出码 ${code}`).trim().slice(-600);
                state.stats.failed++;
                log(`转译失败 ${id}（退出码 ${code}）：${String(m.error).split('\n').pop()}`);
            }
            resolve();
        });
        ch.on('error', (e) => {
            clearTimeout(timer);
            state.running = null;
            m.status = 'error'; m.error = String(e.message || e);
            state.stats.failed++;
            log(`转译启动失败 ${id}：${m.error}`);
            resolve();
        });
    });
}

/** 串行泵：一次只转一个 */
async function pump() {
    if (state.running || !state.python.ok) return;
    while (state.pending.length) {
        const id = state.pending.shift();
        await convertOne(id);
    }
}

async function start() {
    // 整个初始化都包在 try 里：这段代码跑在 listen 之后的异步流程中，
    // 任何未捕获异常在 Node 16+ 会成为 unhandled rejection 并**杀掉进程** ——
    // 一个可选功能绝不能把整个站点带走（只读文件系统、缺 python、目录不存在都要能活）。
    try {
        state.startedAt = Date.now();
        const ok = ensureDirs();
        checkPython();
        log(`初始化：root=${DETECT_ROOT === path.join(APP_ROOT, 'models', 'detect') ? 'models/detect' : '(CX_DETECT_ROOT 指定)'}` +
            `，python=${state.python.cmd || '未找到'}` + (state.python.ok ? '' : '（自动打框将不可用）'));
        if (!ok) return;                       // 目录不可写：直接降级，不再做任何 FS 操作
        await scanAndEnqueue({ force: FORCE });
        if (!AUTOCONVERT) {
            log('CX_DETECT_AUTOCONVERT=0：只扫描不转译（可 POST /api/detect/rescan 手动触发）');
            state.pending = [];
            return;
        }
        pump().catch((e) => log('转译队列异常（已忽略，不影响服务）：' + e.message));   // 后台跑，异常自己消化
    } catch (e) {
        log('初始化失败（已降级，不影响服务）：' + ((e && e.message) || e));
    }
}

async function rescan({ force = false, convert = true } = {}) {
    if (!state.python.ok) checkPython();
    await scanAndEnqueue({ force });
    if (convert && state.python.ok) pump();
    return payload();
}

function payload() {
    const models = [...state.models.values()].map((m) => ({
        id: m.id, kind: m.kind, task: m.task, status: m.status, error: m.error || null,
        classes: m.classes || {}, imgsz: m.imgsz, files: m.files || {}, ms: m.ms || null,
        source: m.source,
        urls: Object.keys(m.files || {}).reduce((acc, k) => {
            acc[k] = '/detect-model/' + m.files[k].file; return acc;
        }, {}),
    }));
    models.sort((a, b) => (a.kind === b.kind ? a.id.localeCompare(b.id) : a.kind.localeCompare(b.kind)));
    return {
        available: state.python.ok,
        python: Object.assign({}, state.python, { cmd: maskPath(state.python.cmd) }),
        runtime: {
            dir: '/detect-runtime/',
            installed: fs.existsSync(path.join(RUNTIME_DIR, 'ort.min.js')),
            files: fs.existsSync(RUNTIME_DIR) ? fs.readdirSync(RUNTIME_DIR) : [],
        },
        autoconvert: AUTOCONVERT,
        force: FORCE,
        paths: { root: 'models/detect', build: 'models/detect/build', segm: 'models/detect/segm', bbox: 'models/detect/bbox' },
        models,
        queue: { pending: state.pending.slice(), running: state.running, done: state.stats.done, failed: state.stats.failed },
        scanning: state.scanning,
        dir: {
            // root 也脱敏：仓库内给相对路径，仓库外只给 basename（避免公网部署暴露服务器目录结构）
            root: EXPOSE_DIAG ? DETECT_ROOT
                : (DETECT_ROOT.startsWith(APP_ROOT) ? path.relative(APP_ROOT, DETECT_ROOT)
                    : path.basename(DETECT_ROOT)),
            writable: !state.dirError, error: state.dirError || null,
        },
        logs: state.logs.slice(-12).map(maskLogLine),
        hint: state.dirError
            ? ('模型目录不可写：' + state.dirError + '（用 CX_DETECT_ROOT 指向可写目录，或给容器挂一个卷）')
            : (state.python.ok
                ? (models.length ? null : '把模型（.pt / .onnx）放进 models/detect/segm/ 或 models/detect/bbox/，然后 POST /api/detect/rescan 或重启服务。')
                : state.python.hint),
    };
}

/**
 * 挂路由（server.js 只调这一个函数，改动面最小）
 *   GET  /api/detect/models    模型清单 + 转译进度 + 环境诊断
 *   POST /api/detect/rescan    重新扫描（可 ?force=1 强制重转）
 *   GET  /detect-model/*       build 产物（带缓存）
 *   GET  /detect-runtime/*     ONNX Runtime 的 js/wasm（带缓存）
 */
function mountRoutes(app, express) {
    const ex = express || require('express');
    app.get('/api/detect/models', (req, res) => {
        res.setHeader('Cache-Control', 'no-store');
        res.json(payload());
    });
    app.post('/api/detect/rescan', async (req, res) => {
        const force = req.query.force === '1';
        res.setHeader('Cache-Control', 'no-store');
        res.json(await rescan({ force }));
    });
    const cached = { etag: true, lastModified: true, maxAge: '7d' };
    app.use('/detect-model', ex.static(BUILD_DIR, cached));
    app.use('/detect-runtime', ex.static(RUNTIME_DIR, cached));
}

module.exports = { start, rescan, payload, mountRoutes, DETECT_ROOT, BUILD_DIR, RUNTIME_DIR };
