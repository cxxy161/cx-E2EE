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
    // 本机局域网 IPv4（证书 SAN 需包含它，否则手机访问 IP 时证书不匹配 → Chrome 抑制摄像头权限弹窗）
    let lanIP = '';
    try {
        const os = require('os');
        const nets = os.networkInterfaces();
        for (const name of Object.keys(nets)) for (const ni of nets[name]) {
            if (ni.family === 'IPv4' && !ni.internal) { lanIP = ni.address; break; }
            if (lanIP) break;
        }
    } catch (e) {}
    if (!fs.existsSync(certPath)) {
        console.log('生成自签证书（SAN: localhost/127.0.0.1' + (lanIP ? '/' + lanIP : '') + '）…');
        try {
            const san = `-addext "subjectAltName=DNS:localhost,IP:127.0.0.1${lanIP ? ',IP:' + lanIP : ''}"`;
            execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyPath}" -out "${certPath}" -days 3650 -nodes -subj "/CN=localhost" ${san}`);
        } catch (e) {
            console.error('自签证书生成失败（需要 openssl）：', e.message);
            process.exit(1);
        }
    } else {
        console.log('证书已存在：删除 data/cert.pem、data/key.pem 并重启可重新生成（含 SAN）。');
    }
    const https = require('https');
    https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, handler)
        .listen(9443, '0.0.0.0', () => console.log('Server(HTTPS): https://' + (lanIP || '<本机IP>') + ':9443'));
} else {
    // /cert/cert.pem → 自签证书下载（供手机安装为受信 CA，装完摄像头权限弹窗即恢复）
    const certPath = path.resolve(__dirname, '..', 'data', 'cert.pem');
    const certHandler = (req, res) => {
        const u = req.url.split('?')[0];
        if (u === '/cert/cert.pem') {
            fs.readFile(certPath, (err, data) => {
                if (err) { res.writeHead(404); res.end('no cert'); return; }
                res.writeHead(200, { 'Content-Type': 'application/x-pem-file', 'Content-Disposition': 'attachment; filename="cx-e2ee-cert.pem"' });
                res.end(data);
            });
            return true;
        }
        return false;
    };
    http.createServer((req, res) => { if (!certHandler(req, res)) handler(req, res); })
        .listen(9091, '0.0.0.0', () => console.log('Server: http://localhost:9091  （证书下载: http://<IP>:9091/cert/cert.pem）'));
}
