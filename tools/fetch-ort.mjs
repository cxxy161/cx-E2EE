#!/usr/bin/env node
/**
 * fetch-ort.mjs — 把 ONNX Runtime Web 拉到 src/vendor/ort/（自托管，不走 CDN）
 *
 * 为什么要自托管
 * --------------
 * 1) 这个项目其余第三方件都在 src/vendor/（nacl-fast.min.js 等），客户端零外链是既有约定；
 * 2) 自动打框是"本机识别、图片不上传"，再让页面去第三方 CDN 取运行时说不通；
 * 3) 版本与 sha256 固定，避免某天上游发新版把行为改掉（模型/算子差异会直接表现为
 *    "框突然不对"，那样的排查成本极高）。
 *
 * 体积（1.30.0，实测）
 *    wasm 后端：ort.min.js 368KB + ort-wasm-simd-threaded.{mjs,wasm} 24KB+13.6MB
 *    WebGPU 后端：ort.webgpu.min.js 66KB + jsep.{mjs,wasm} 47KB+27MB + asyncify.{mjs,wasm} 53KB+26.8MB
 *    只跑 WASM 的话用 `--only wasm` 跳过 WebGPU 那三组。
 *
 * 用法
 *   node tools/fetch-ort.mjs            # 全量（含 WebGPU）
 *   node tools/fetch-ort.mjs --only wasm
 *   node tools/fetch-ort.mjs --force     # 无视已有文件重新下载
 */

import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(HERE, '..', 'src', 'vendor', 'ort');

const VERSION = '1.30.0';
const MIRRORS = [
    `https://cdn.jsdelivr.net/npm/onnxruntime-web@${VERSION}/dist/`,
    `https://unpkg.com/onnxruntime-web@${VERSION}/dist/`,
];

/** 固定版本 + 固定哈希（本机实测值，来自 1.30.0 的 dist 目录） */
const FILES = [
    { name: 'ort.min.js', sha256: '7ae472a8ec976bcb69ad46b89b0a6ec8f3c5dbea4477674a26958672d1f3322d', set: 'wasm' },
    { name: 'ort-wasm-simd-threaded.mjs', sha256: 'e13f7f94fc51b4ca72b12faeb1ee95f4ace6dfbc8939bc718aabdc0a27c4299b', set: 'wasm' },
    { name: 'ort-wasm-simd-threaded.wasm', sha256: '3398c10d07d229bd91b364548e130e0e51a8e5704b88c7c083ebbeb78842dee2', set: 'wasm' },
    { name: 'ort.webgpu.min.js', sha256: '7d65dad7eb4564ad98db9924a259af2e2c68ebfbdbf254fa5d728f1c5736e07a', set: 'webgpu' },
    { name: 'ort-wasm-simd-threaded.jsep.mjs', sha256: '709853412fd1ffc34247af1e73569227b5b79629c5ca3f59cc39cf7e500e4947', set: 'webgpu' },
    { name: 'ort-wasm-simd-threaded.jsep.wasm', sha256: '3ad23231b5bd6d9dda55a7f84606315e0bf35b6750c28ee993c987c54cacab0f', set: 'webgpu' },
    // WebGPU 构建的 wasm 侧车会去要 asyncify 版本（少这一个文件就会在浏览器里报
    // "Failed to fetch dynamically imported module …asyncify.mjs"，实测踩过）
    { name: 'ort-wasm-simd-threaded.asyncify.mjs', sha256: '3d1c85995364bb643302fc6fd877a0c3ba5ae72401815e0f24828a53d9191e28', set: 'webgpu' },
    { name: 'ort-wasm-simd-threaded.asyncify.wasm', sha256: '39f9f0894d478800487ed9f7dbe92618498db320cf55c8e3d89adff8dce658da', set: 'webgpu' },
];

const LICENSE_TXT = `ONNX Runtime Web ${VERSION}
上游：https://github.com/microsoft/onnxruntime （npm 包 onnxruntime-web）
许可：MIT

本文件由 tools/fetch-ort.mjs 随运行时一起写入，便于离线自查来源与版本。
下列为 MIT 许可的通行文本（版权归微软）：

MIT License

Copyright (c) Microsoft Corporation.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;

function sha256(buf) { return createHash('sha256').update(buf).digest('hex'); }

async function download(url) {
    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return Buffer.from(await res.arrayBuffer());
}

async function main() {
    const argv = process.argv.slice(2);
    const force = argv.includes('--force');
    const onlyIdx = argv.indexOf('--only');
    const only = onlyIdx >= 0 ? argv[onlyIdx + 1] : null;
    const want = FILES.filter((f) => !only || f.set === only);

    mkdirSync(OUT_DIR, { recursive: true });
    console.log(`ONNX Runtime Web ${VERSION} → ${OUT_DIR}`);
    console.log(only ? `只取 ${only} 组（共 ${want.length} 个文件）` : `全量（共 ${want.length} 个文件）`);

    let ok = 0, skipped = 0, failed = 0;
    for (const f of want) {
        const dst = join(OUT_DIR, f.name);
        if (!force && existsSync(dst)) {
            const got = sha256(readFileSync(dst));
            if (got === f.sha256) {
                console.log(`  = ${f.name}（已存在且哈希一致，${(statSync(dst).size / 1048576).toFixed(2)} MB）`);
                skipped++;
                continue;
            }
            console.log(`  ! ${f.name} 哈希不符，重新下载`);
        }
        let done = false;
        for (const base of MIRRORS) {
            try {
                const buf = await download(base + f.name);
                const got = sha256(buf);
                if (got !== f.sha256) throw new Error(`sha256 不符（得到 ${got.slice(0, 12)}…）`);
                writeFileSync(dst, buf);
                console.log(`  + ${f.name}  ${(buf.length / 1048576).toFixed(2)} MB  sha256 ✓`);
                ok++;
                done = true;
                break;
            } catch (e) {
                console.log(`  · ${base}${f.name} 失败：${e.message}`);
            }
        }
        if (!done) { console.log(`  ✗ ${f.name} 全部镜像都失败`); failed++; }
    }

    writeFileSync(join(OUT_DIR, 'ort-LICENSE'), LICENSE_TXT);
    console.log(`\n下载 ${ok} / 复用 ${skipped} / 失败 ${failed}；已写入 ort-LICENSE`);
    if (failed) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
