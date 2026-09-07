const http = require('http');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.svg': 'image/svg+xml'
};

// Local static preview server — serves the frontend from ../src.
// 默认 http://localhost:9091；设 HTTPS=1 则用自签证书起 https://<ip>:9443（手机扫码器需要 secure context 才能调摄像头）
const ROOT = path.resolve(__dirname, '..', 'src');
const httpsMode = process.env.HTTPS === '1';

const handler = (req, res) => {
    let url = req.url.split('?')[0];
    if (url === '/') url = '/index.html';
    const fp = path.join(ROOT, url);
    fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); res.end('Not Found'); return; }
        const ext = path.extname(fp);
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream', 'Cache-Control': 'no-store' });
        res.end(data);
    });
};

if (httpsMode) {
    const certPath = path.resolve(__dirname, '..', 'data', 'cert.pem');
    const keyPath = path.resolve(__dirname, '..', 'data', 'key.pem');
    if (!fs.existsSync(certPath)) {
        console.log('生成自签证书…');
        try {
            execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes -subj "/CN=localhost"`);
        } catch (e) {
            console.error('自签证书生成失败（需要 openssl）：', e.message);
            process.exit(1);
        }
    }
    const https = require('https');
    https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler)
        .listen(9443, '0.0.0.0', () => console.log('Server(HTTPS): https://<本机IP>:9443  （手机访问并信任自签证书即可用摄像头扫码器）'));
} else {
    http.createServer(handler).listen(9091, '0.0.0.0', () => console.log('Server: http://localhost:9091  （手机扫码需 HTTPS=1 node server/serve.js）'));
}
