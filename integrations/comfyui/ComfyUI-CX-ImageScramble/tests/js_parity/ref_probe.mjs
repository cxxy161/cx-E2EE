// ref_probe.mjs — 抽取 IA.hash / IA.perm / IA.rng 的对照值
// 用法: node ref_probe.mjs <spec.json> <out.json>
//   spec.json: {"hashes":["pwd#0"],"perms":[[1024,12345]],"rng":[[12345,4]]}
// 用文件交换（而不是 argv/stdout）是为了彻底避开 Windows 控制台代码页对非 ASCII 的干扰。
import fs from "node:fs";
import { IA } from "./ref_impl.mjs";

const [specPath, outPath] = process.argv.slice(2);
const spec = JSON.parse(fs.readFileSync(specPath, "utf8"));
const out = { hashes: {}, perms: {}, rng: {} };
for (const s of spec.hashes || []) out.hashes[s] = IA.hash(s);
for (const [n, seed] of spec.perms || []) out.perms[`${n}:${seed}`] = Array.from(IA.perm(n, seed));
for (const [seed, count] of spec.rng || []) {
  const r = IA.rng(seed);
  const v = [];
  for (let i = 0; i < count; i++) v.push(r());
  out.rng[`${seed}:${count}`] = v;
}
fs.writeFileSync(outPath, JSON.stringify(out), "utf8");
console.log("PROBE_DONE " + outPath);
