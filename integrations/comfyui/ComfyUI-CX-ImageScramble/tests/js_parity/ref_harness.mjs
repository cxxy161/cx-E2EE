// ref_harness.mjs — 用真 JS 实现跑一次 regionEnc，输入输出都是裸 RGBA 字节
// 用法: node ref_harness.mjs <in.raw> <w> <h> <x> <y> <rw> <rh> <seed> <unit> <soft 0|1> <enc 0|1> <out.raw>
import fs from "node:fs";
import { IA } from "./ref_impl.mjs";

const a = process.argv.slice(2);
if (a.length < 12) {
  console.error("usage: node ref_harness.mjs in.raw w h x y rw rh seed unit soft enc out.raw");
  process.exit(2);
}
const [inp, w, h, x, y, rw, rh, seed, unit, soft, enc, outp] = a;
const W = +w, H = +h;
const buf = fs.readFileSync(inp);
const RGBA = 4;
if (buf.length !== W * H * RGBA) {
  console.error(`bad raw size: ${buf.length} != ${W * H * RGBA}`);
  process.exit(3);
}
const d = new Uint8ClampedArray(buf); // JS 侧就是 ImageData.data 的语义
IA.regionEnc(
  d, W, H,
  { x: +x, y: +y, w: +rw, h: +rh },
  +seed, enc === "1", false /* sort=false：网页端 PNG 默认 */, soft === "1", +unit
);
fs.writeFileSync(outp, Buffer.from(d.buffer, d.byteOffset, d.byteLength));
console.log("JS_DONE " + outp);
