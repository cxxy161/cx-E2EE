const express = require('express');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');
const crypto = require('crypto');

const POW_BITS = 16;

// Project root = parent of this server/ directory → so the same code paths
// resolve whether run from the repo root or inside the container workdir.
const APP_ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(APP_ROOT, 'data', 'pubkey_store.json');

function ensureDBDir() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
}

const app = express();
app.use(express.json({ limit: '1mb' }));

function loadDB() {
    if (!fs.existsSync(DB_PATH)) {
        ensureDBDir();
        fs.writeFileSync(DB_PATH, '{}', 'utf8');
    }
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
}

function saveDB(db) {
    fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf8');
}

function b64decode(str) {
    try {
        const bin = Buffer.from(str.replace(/\s+/g, ''), 'base64');
        return new Uint8Array(bin);
    } catch {
        return null;
    }
}

function isValidPubkey(str) {
    const buf = b64decode(str);
    return buf && buf.length === 32;
}

function verifyPow(id, spk, epk, ts, nonce) {
    if (typeof nonce !== 'number' || nonce < 0 || !Number.isInteger(nonce)) return false;
    const hash = crypto.createHash('sha256')
        .update(`${id}\n${spk}\n${epk}\n${ts}\n${nonce}`)
        .digest();
    let zeros = 0;
    for (const byte of hash) {
        if (byte === 0) { zeros += 8; continue; }
        let m = 0x80;
        while (!(byte & m)) { zeros++; m >>= 1; }
        break;
    }
    return zeros >= POW_BITS;
}

app.post('/api/update', (req, res) => {
    const { id, signing_pubkey, encryption_pubkey, timestamp, signature, pow_nonce } = req.body;

    if (!id || !signing_pubkey || !encryption_pubkey || !timestamp || !signature || pow_nonce === undefined) {
        return res.status(400).json({ error: '字段不完整，需提供 id, signing_pubkey, encryption_pubkey, timestamp, signature, pow_nonce' });
    }

    if (!verifyPow(id, signing_pubkey, encryption_pubkey, timestamp, pow_nonce)) {
        return res.status(429).json({ error: '工作量证明无效，请重试' });
    }

    if (typeof id !== 'string' || !id.trim()) {
        return res.status(400).json({ error: 'id 无效' });
    }

    if (!isValidPubkey(signing_pubkey)) {
        return res.status(400).json({ error: '签名公钥格式无效 (需32字节 Base64)' });
    }

    if (!isValidPubkey(encryption_pubkey)) {
        return res.status(400).json({ error: '加密公钥格式无效 (需32字节 Base64)' });
    }

    if (typeof timestamp !== 'number' || timestamp <= 0) {
        return res.status(400).json({ error: '时间戳无效' });
    }

    const sigBuf = b64decode(signature);
    if (!sigBuf || sigBuf.length !== 64) {
        return res.status(400).json({ error: '签名格式无效 (需64字节 Base64)' });
    }

    const payload = `${id}\n${signing_pubkey}\n${encryption_pubkey}\n${timestamp}`;
    const payloadBytes = Buffer.from(payload, 'utf8');

    const db = loadDB();

    if (db[id]) {
        if (timestamp <= db[id].timestamp) {
            return res.status(400).json({ error: '重放攻击: 时间戳必须大于已有记录' });
        }

        const oldPubkey = b64decode(db[id].signing_pubkey);
        if (!oldPubkey) {
            return res.status(500).json({ error: '数据库公钥损坏' });
        }

        const valid = nacl.sign.detached.verify(payloadBytes, sigBuf, oldPubkey);
        if (!valid) {
            return res.status(403).json({ error: 'ID已被占用或权限不足' });
        }

        db[id] = { id, signing_pubkey, encryption_pubkey, timestamp, signature };
        saveDB(db);
        return res.json({ status: 'updated', id });
    }

    const newPubkey = b64decode(signing_pubkey);
    if (!newPubkey) {
        return res.status(400).json({ error: '签名公钥解码失败' });
    }

    const valid = nacl.sign.detached.verify(payloadBytes, sigBuf, newPubkey);
    if (!valid) {
        return res.status(400).json({ error: '自签名验证失败，签名与签名公钥不匹配' });
    }

    db[id] = { id, signing_pubkey, encryption_pubkey, timestamp, signature };
    saveDB(db);
    return res.json({ status: 'created', id });
});

app.get('/api/pubkey/:id', (req, res) => {
    const db = loadDB();
    const entry = db[req.params.id];
    if (!entry) {
        return res.status(404).json({ error: '未找到该ID' });
    }
    res.json(entry);
});

// 静态资源必须禁用缓存。
//
// 为什么不能交给 express 默认策略：默认会带 ETag 并返回 304，
// 于是浏览器可能拿「新的 text-crypto.html + 旧的 core.js/cx2.js」混搭运行。
// 一旦线格式或函数签名不匹配，解密就会失败并报成
// 「认证失败：正文密文与密钥不匹配」——指向完全错误的原因，极难排查。
// 这是本地开发/自托管场景，禁用缓存比省这点流量重要得多。
app.use(express.static(path.join(APP_ROOT, 'src'), {
    etag: false,
    lastModified: false,
    setHeaders(res) {
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Expires', '0');
    }
}));

// 语言隐写模型资产：单一真源在 .pcd/pcd-v3-6M-fixedpoint/model/，
// 不复制进 src/。浏览器经 /stego-model/ 取。
app.use('/stego-model', express.static(
    path.join(APP_ROOT, '.pcd', 'pcd-v3-6M-fixedpoint', 'model'),
    { etag: false, lastModified: false }
));


const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`C-X Server running on 0.0.0.0:${PORT}`);
});
