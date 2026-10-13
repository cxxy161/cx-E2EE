// ref_meta.mjs — V3 元数据层（metaBytes/parseMeta/borderOrd/wMetaPng/rMetaPng）的真 JS 对照
// 用法: node ref_meta.mjs <spec.json> <out.json> [python_raw_rgba]
import fs from "node:fs";
import { IA } from "./ref_impl.mjs";

const [specPath, outPath, pyImg] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const out = { cases: [], pyimg: null };

for (const c of spec.cases || []) {
  const regions = c.regions.map((r) => ({ x: r[0], y: r[1], w: r[2], h: r[3] }));
  const bs = IA.metaBytes(c.count, regions, c.k, c.flag !== undefined ? c.flag : 4,
                          c.dataLen || 0);
  const ord = IA.borderOrd(c.cw, c.ch, 8);
  const d = new Uint8ClampedArray(c.cw * c.ch * 4).fill(255);
  const wrote = IA.wMetaPng(bs, d, ord);
  const back = IA.rMetaPng(d, ord, 200);
  const parsed = IA.parseMeta(back);
  out.cases.push({
    cw: c.cw, ch: c.ch, bytes: bs, order: ord, wrote,
    wrote_head: Array.from(d.slice(0, 64)),
    parsed, back: Array.from(back),
  });
  fs.writeFileSync(outPath + ".rgba." + c.cw + "x" + c.ch, Buffer.from(d.buffer));
}
if (pyImg) {
  const buf = fs.readFileSync(pyImg);
  const d = new Uint8ClampedArray(buf);
  const ord = IA.borderOrd(spec.pyimg_w, spec.pyimg_h, 8);
  out.pyimg = { parsed: IA.parseMeta(IA.rMetaPng(d, ord, 200)) };
}
fs.writeFileSync(outPath, JSON.stringify(out), "utf8");
console.log("META_DONE");
