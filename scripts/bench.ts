// CPU benchmark for the per-message work, run in Node (same V8 as workerd).
// Usage: pnpm bench <file.jsonl>   (one {"raw": "..."} object per line; keep real mail out of the repo)
// Workers freeze timers during execution, so CPU cannot be measured inside workerd itself.
import { readFileSync } from "node:fs";
import { DEFAULT_GZIP_MAX_BYTES, DEFAULT_PARSE_BYTES, RETRY_PARSE_BYTES, summarizeBody, summarizeHeaders } from "../src/ingest";
import { gunzip, gzip } from "../src/util";
import { headersOf } from "../test/headers";
import { parseFull, renderBodyHtml } from "../src/view";

const file = process.argv[2];
if (!file) {
  console.error("usage: bench <file.jsonl>");
  process.exit(2);
}
const enc = new TextEncoder();
const raws = readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => enc.encode((JSON.parse(l) as { raw: string }).raw));

function cpuMs(): number {
  const u = process.cpuUsage();
  return (u.user + u.system) / 1000;
}

async function measure(label: string, fn: (raw: Uint8Array) => Promise<unknown>) {
  for (const raw of raws.slice(0, 20)) await fn(raw); // warm the JIT, as a reused isolate would be
  const samples: { ms: number; size: number }[] = [];
  for (const raw of raws) {
    const t = cpuMs();
    await fn(raw);
    samples.push({ ms: cpuMs() - t, size: raw.byteLength });
  }
  samples.sort((a, b) => a.ms - b.ms);
  const q = (p: number) => samples[Math.min(samples.length - 1, Math.floor(samples.length * p))]!.ms.toFixed(2);
  const over = samples.filter((s) => s.ms > 10);
  console.log(
    `${label.padEnd(10)} n=${samples.length} p50=${q(0.5)}ms p90=${q(0.9)}ms p99=${q(0.99)}ms max=${q(1)}ms over10ms=${over.length}` +
      (over.length ? ` (sizes: ${over.map((s) => Math.round(s.size / 1024) + "KB").slice(0, 8).join(", ")})` : ""),
  );
}

const sizes = raws.map((r) => r.byteLength).sort((a, b) => a - b);
console.log(`messages=${raws.length} size p50=${Math.round(sizes[sizes.length >> 1]! / 1024)}KB max=${Math.round(sizes.at(-1)! / 1024)}KB`);

const parseBytes = Number(process.env.PARSE_BYTES ?? DEFAULT_PARSE_BYTES);
const gzipMax = Number(process.env.GZIP_MAX_BYTES ?? DEFAULT_GZIP_MAX_BYTES);
console.log(`PARSE_BYTES=${parseBytes} GZIP_MAX_BYTES=${gzipMax}`);
let rawBytes = 0;
let storedBytes = 0;
// Phase 1, inside email(): header parse + gzip of small mail. Must stay far below 10 ms.
const headerCache = new Map<Uint8Array, Headers>();
for (const r of raws) headerCache.set(r, headersOf(r)); // built by the runtime, outside our CPU
await measure("arrive", async (raw) => {
  summarizeHeaders(headerCache.get(raw)!);
  const stored = raw.byteLength <= gzipMax ? gzip(raw) : raw;
  rawBytes += raw.byteLength;
  storedBytes += stored.byteLength;
});
console.log(`stored/raw=${(storedBytes / rawBytes).toFixed(3)}`);
// Phase 2, first read or cron: gunzip + body parse.
const stored = raws.map((r) => (r.byteLength <= gzipMax ? { gz: true, d: gzip(r) } : { gz: false, d: r }));
let i = 0;
await measure("parse", async () => {
  const s = stored[i++ % stored.length]!;
  await summarizeBody(s.gz ? gunzip(s.d) : s.d, parseBytes);
});
await measure("parse-retry", (raw) => summarizeBody(raw, RETRY_PARSE_BYTES));
// Viewing: full parse + render.
await measure("view", async (raw) => {
  const email = await parseFull(raw);
  renderBodyHtml(email, "0".repeat(28), "1.0.a", "/base", false);
});
