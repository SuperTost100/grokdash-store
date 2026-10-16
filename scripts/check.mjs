// Checks what the dashboard checks before installing, so a broken manifest never reaches a store:
// every addon.json, its files, store.json's list, and that the built files match the sources.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { ENTRIES } from "../build.mjs";

const problems = [];
const ID = /^[a-z][a-z0-9-]{1,30}$/;
const ASKS = ["messages", "agenda", "todos", "cards", "handoffs", "triage", "decide"];
const store = JSON.parse(fs.readFileSync("store.json", "utf8"));
const listed = new Set(store.items.map((i) => i.path));

for (const dir of ["addons", "apps"].flatMap((d) => fs.readdirSync(d).map((n) => `${d}/${n}`))) {
  const file = `${dir}/addon.json`;
  if (!fs.existsSync(file)) { problems.push(`${dir}: no addon.json`); continue; }
  const m = JSON.parse(fs.readFileSync(file, "utf8"));
  const where = (msg) => problems.push(`${file}: ${msg}`);
  if (!ID.test(m.id ?? "")) where(`bad id "${m.id}"`);
  if (path.basename(dir) !== m.id) where(`folder name and id differ`);
  if (!["addon", "app"].includes(m.type)) where(`type must be addon or app`);
  if (m.type === "addon" && !fs.existsSync(`${dir}/${m.entry}`)) where(`entry ${m.entry} is missing`);
  if (m.type === "app" && !fs.existsSync(`${dir}/${m.compose}`)) where(`compose ${m.compose} is missing`);
  for (const a of m.asks ?? []) if (!ASKS.includes(a)) where(`unknown ask "${a}"`);
  for (const s of m.settings ?? []) if (!/^[a-zA-Z][a-zA-Z0-9_]{0,40}$/.test(s.key) || !s.label) where(`setting ${JSON.stringify(s.key)} needs a key and a label`);
  if (!listed.has(dir)) where(`not listed in store.json`);
  if (m.type === "app") {
    const compose = JSON.parse(fs.readFileSync(`${dir}/${m.compose}`, "utf8"));
    for (const name of Object.keys(compose.services ?? {})) if (name !== m.id && !name.startsWith(`${m.id}-`)) where(`service "${name}" must start with "${m.id}-"`);
    const keys = new Set((m.settings ?? []).map((s) => `SETTING_${s.key.toUpperCase()}`));
    for (const v of JSON.stringify(compose).match(/\$\{SETTING_[A-Z0-9_]+\}/g) ?? []) if (!keys.has(v.slice(2, -1))) where(`${v} isn't a setting`);
  }
}
for (const p of listed) if (!fs.existsSync(`${p}/addon.json`)) problems.push(`store.json lists ${p}, which has no addon.json`);

// The committed bundles must be what the sources build to.
const before = Object.fromEntries(Object.values(ENTRIES).map((f) => [f, fs.existsSync(f) ? fs.readFileSync(f, "utf8") : ""]));
execFileSync("node", ["build.mjs"], { stdio: "ignore" });
for (const [f, text] of Object.entries(before)) if (fs.readFileSync(f, "utf8") !== text) problems.push(`${f} is out of date: run npm run build and commit it`);

if (problems.length) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`store.json and ${listed.size} manifests look right; the built files are current.`);
