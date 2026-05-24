const express = require('express');
const fs = require('fs');
const path = require('path');
const nacl = require('tweetnacl');

const app = express();
app.use(express.json({ limit: '1mb' }));

const DB_PATH = path.join(__dirname, 'pubkey_store.json');

function loadDB() {
    if (!fs.existsSync(DB_PATH)) {
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

app.post('/api/update', (req, res) => {
    const { id, signing_pubkey, encryption_pubkey, timestamp, signature } = req.body;

    if (!id || !signing_pubkey || !encryption_pubkey || !timestamp || !signature) {
        return res.status(400).json({ error: '字段不完整，需提供 id, signing_pubkey, encryption_pubkey, timestamp, signature' });
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

app.use(express.static(__dirname));

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`C-X Server running on 0.0.0.0:${PORT}`);
});
