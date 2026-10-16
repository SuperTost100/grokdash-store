// Bundles each add-on (and each app's adapter) into one file with its dependencies and the SDK,
// so the dashboard can run it without installing anything. Run after changing anything in src/ or sdk/.
import { build } from "esbuild";

export const ENTRIES = {
  todoist: "addons/todoist/index.mjs",
  calendar: "addons/calendar/index.mjs",
  mail: "addons/mail/index.mjs",
  shipments: "addons/shipments/index.mjs",
  "plan-my-day": "addons/plan-my-day/index.mjs",
  whatsapp: "apps/whatsapp/adapter/index.mjs",
  polito: "apps/polito/adapter/index.mjs",
};

// Imported by scripts/check.mjs for ENTRIES only: build only when run directly.
const direct = import.meta.url === `file://${process.argv[1]}`;
const only = process.argv.slice(2);
for (const [name, out] of direct ? Object.entries(ENTRIES) : []) {
  if (only.length && !only.includes(name)) continue;
  await build({
    entryPoints: [`src/${name}/index.mjs`],
    outfile: out,
    bundle: true,
    platform: "node",
    target: "node24",
    format: "esm",
    legalComments: "none",
    // Some dependencies still call require(): give the bundle one.
    banner: { js: `// Built from src/${name} by build.mjs. Don't edit: change the source and run npm run build.\nimport { createRequire as __cr } from "node:module"; const require = __cr(import.meta.url);` },
    logLevel: "warning",
  });
  console.log(`built ${out}`);
}
