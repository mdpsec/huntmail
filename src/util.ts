import { gunzipSync, gzipSync } from "node:zlib";

export const enc = new TextEncoder();
export const dec = new TextDecoder();

/** Time-sortable unique id: 12 hex chars of unix ms + 16 random hex chars. */
export function newId(now = Date.now()): string {
  const rand = crypto.getRandomValues(new Uint8Array(8));
  return now.toString(16).padStart(12, "0") + toHex(rand);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export function intVar(value: string | undefined, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Comma-separated var as a trimmed, lowercased, de-duplicated list. */
export function listVar(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((v) => v.trim().toLowerCase()).filter(Boolean))];
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

export function errorJson(status: number, error: string): Response {
  return json({ error }, status);
}

/** Accepts unix ms, unix seconds, or an ISO date. Returns unix ms or null. */
export function parseTime(value: string | null): number | null {
  if (!value) return null;
  if (/^\d+$/.test(value)) {
    const n = Number(value);
    return n < 1e11 ? n * 1000 : n;
  }
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

export function concatBytes(parts: Uint8Array[], total?: number): Uint8Array {
  const size = total ?? parts.reduce((n, p) => n + p.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    total += value.byteLength;
  }
  if (parts.length === 1 && parts[0]!.byteLength === total) return parts[0]!;
  return concatBytes(parts, total);
}

/**
 * gzip at level 1. node:zlib (native in workerd under nodejs_compat) is used instead of
 * CompressionStream because it allows a level, and level 1 costs about half the CPU of the
 * default for only a few percent more bytes.
 */
export function gzip(data: Uint8Array, level = 1): Uint8Array {
  const out = gzipSync(data, { level });
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

export function gunzip(data: Uint8Array): Uint8Array {
  const out = gunzipSync(data);
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}
