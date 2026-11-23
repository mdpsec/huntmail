// Builds dist/huntmail-bundle/: a prebuilt Worker plus everything a tool needs to install or update
// HuntMail through the Cloudflare API alone, with no Node or wrangler on the user's machine.
// Deterministic: the same source and lockfile give the same bytes. See docs/SETUP.md, "Prebuilt bundle".
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const out = join(root, "dist/huntmail-bundle");
const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
// The public template, comments stripped (whole-line // comments only, as in the file).
const config = JSON.parse(
  readFileSync(join(root, "wrangler.jsonc"), "utf8")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n"),
);
const version = /export const VERSION = "([^"]+)"/.exec(readFileSync(join(root, "src/version.ts"), "utf8"))?.[1];
if (version !== pkg.version) throw new Error(`src/version.ts (${version}) and package.json (${pkg.version}) differ`);

// Exactly what `wrangler deploy` uploads, built by wrangler itself.
const build = mkdtempSync(join(tmpdir(), "huntmail-bundle-"));
try {
  execFileSync(join(root, "node_modules/.bin/wrangler"), ["deploy", "--dry-run", "--outdir", build, "--config", join(root, "wrangler.jsonc")], {
    cwd: root,
    stdio: ["ignore", "ignore", "inherit"],
    env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
  });
  rmSync(out, { recursive: true, force: true });
  mkdirSync(join(out, "migrations"), { recursive: true });
  // index.js only: the source map and wrangler's README (it has a timestamp) are left out.
  copyFileSync(join(build, "index.js"), join(out, "index.js"));
} finally {
  rmSync(build, { recursive: true, force: true });
}

const migrations = readdirSync(join(root, "migrations")).filter((f) => f.endsWith(".sql")).sort();
for (const m of migrations) copyFileSync(join(root, "migrations", m), join(out, "migrations", m));
copyFileSync(join(root, "LICENSE"), join(out, "LICENSE"));

// Third-party code inside index.js: postal-mime only (checked against the build's source map).
const pm = JSON.parse(readFileSync(join(root, "node_modules/postal-mime/package.json"), "utf8"));
const pmLicense = readFileSync(join(root, "node_modules/postal-mime/LICENSE.txt"), "utf8").trim();
writeFileSync(
  join(out, "THIRD_PARTY_NOTICES.md"),
  `# Third-party notices\n\n\`index.js\` includes the following package.\n\n## postal-mime ${pm.version} (${pm.license})\n\n${pm.homepage ?? "https://github.com/postalsys/postal-mime"}\n\n\`\`\`\n${pmLicense}\n\`\`\`\n`,
);

const manifest = {
  name: "huntmail",
  version: pkg.version,
  main_module: "index.js",
  modules: [{ name: "index.js", type: "esm", sha256: sha256(readFileSync(join(out, "index.js"))) }],
  compatibility_date: config.compatibility_date,
  compatibility_flags: config.compatibility_flags ?? [],
  crons: config.triggers?.crons ?? [],
  observability: config.observability ?? { enabled: false },
  workers_dev: config.workers_dev !== false,
  d1_binding: config.d1_databases[0].binding,
  vars: config.vars,
  secrets: ["API_KEY", "BASE_PATH"],
  secret_rules: {
    API_KEY: "at least 32 characters (setup uses 64 hex)",
    BASE_PATH: "16-128 characters of A-Z a-z 0-9 _ - (setup uses 32 hex)",
  },
  migrations: migrations,
  migrations_sha256: Object.fromEntries(migrations.map((m) => [m, sha256(readFileSync(join(out, "migrations", m)))])),
  migrations_table: "d1_migrations",
};
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`dist/huntmail-bundle: huntmail ${pkg.version}, index.js ${manifest.modules[0].sha256.slice(0, 12)}, ${migrations.length} migrations`);
