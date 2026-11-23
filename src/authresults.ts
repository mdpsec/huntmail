// Sender verdicts from the Authentication-Results header Cloudflare's MX adds on arrival.
//
// Only the topmost Authentication-Results header is trusted, and only when its authserv-id is
// mx.cloudflare.net: Cloudflare prepends its own, so anything below it (or any other authserv-id)
// may have been written by the sender. Input is bounded and scanned without backtracking regex.

import type { AuthVerdicts } from "./store";

const MAX_HEADER_SECTION = 64 * 1024;
const MAX_VALUE = 8 * 1024;
const TRUSTED_AUTHSERV = "mx.cloudflare.net";

export const NO_VERDICTS: AuthVerdicts = { spf: "", dkim: "", dmarc: "", verifiedDomains: [], spamScore: null };

/** The top-level header section (up to the first blank line), decoded once. Bounded. */
export function headerSection(raw: Uint8Array): string {
  const head = new TextDecoder().decode(raw.subarray(0, Math.min(raw.byteLength, MAX_HEADER_SECTION)));
  const crlf = head.indexOf("\r\n\r\n");
  const lf = head.indexOf("\n\n");
  const end = crlf === -1 ? lf : lf === -1 ? crlf : Math.min(crlf, lf);
  return end === -1 ? head : head.slice(0, end + 1);
}

/** Value of the first occurrence of a header in a header section, unfolded. */
export function firstHeader(head: string, name: string): string | null {
  const want = name.toLowerCase() + ":";
  let lineStart = 0;
  while (lineStart < head.length) {
    let lineEnd = head.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = head.length;
    const line = head.slice(lineStart, lineEnd).replace(/\r$/, "");
    if (line === "") return null; // end of header section
    if (line.slice(0, want.length).toLowerCase() === want) {
      let value = line.slice(want.length);
      // Folded continuation lines start with whitespace.
      let next = lineEnd + 1;
      while (next < head.length && (head[next] === " " || head[next] === "\t") && value.length < MAX_VALUE) {
        let end = head.indexOf("\n", next);
        if (end === -1) end = head.length;
        value += " " + head.slice(next, end).replace(/\r$/, "").trim();
        next = end + 1;
      }
      return value.slice(0, MAX_VALUE).trim();
    }
    lineStart = lineEnd + 1;
  }
  return null;
}

/**
 * Splits on ";" outside comments and quoted strings, dropping comments. Quoted strings are opaque
 * everywhere, inside comments too, so a ";" or "(" in a quoted value (Cloudflare quotes IPv6
 * addresses, a sender can quote its envelope local part) is never structural. Comments nest.
 * Returns null for unbalanced quotes or comments.
 */
function splitParts(s: string): string[] | null {
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (ch === '"') {
      const close = s.indexOf('"', i + 1);
      if (close === -1) return null;
      if (depth === 0) cur += s.slice(i, close + 1);
      i = close;
    } else if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) return null; // unbalanced: someone closed a comment that was not open
      depth--;
    } else if (depth > 0) continue;
    else if (ch === ";") {
      parts.push(cur.trim());
      cur = "";
    } else cur += ch;
  }
  if (depth !== 0) return null;
  parts.push(cur.trim());
  return parts.filter(Boolean);
}

/** A plain DNS name. Anything else in header.d or header.from is not trusted. */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;

function domainOf(value: string): string {
  const at = value.lastIndexOf("@");
  const d = (at === -1 ? value : value.slice(at + 1)).toLowerCase();
  return HOSTNAME.test(d) ? d : "";
}

/**
 * Characters that, in the envelope sender Cloudflare echoes into its header (smtp.mailfrom and a
 * comment), could change how the header splits. Real senders essentially never use them.
 */
const UNSAFE_ENVELOPE = /["\\()<>;,\s]/;

/**
 * Parsed verdicts plus how many dkim= and dmarc= results the header held, for the consistency
 * checks in authVerdicts.
 */
export function parseAuthResults(value: string | null): AuthVerdicts & { dkimResults: number; dmarcResults: number } {
  const none = { ...NO_VERDICTS, dkimResults: 0, dmarcResults: 0 };
  // Cloudflare never writes backslashes; one means the text was shaped by the sender.
  if (!value || value.includes("\\")) return none;
  const parts = splitParts(value);
  if (!parts || parts[0]?.toLowerCase() !== TRUSTED_AUTHSERV) return none;
  let dmarcResults = 0;

  let spf = "";
  let dmarc = "";
  const dkim: string[] = [];
  const verified = new Set<string>();
  for (const part of parts.slice(1)) {
    const tokens = part.split(/\s+/);
    const [method, result] = (tokens[0] ?? "").toLowerCase().split("=");
    const prop = (key: string) => {
      const t = tokens.find((x) => x.toLowerCase().startsWith(key + "="));
      return t ? t.slice(key.length + 1) : "";
    };
    if (!result) continue;
    if (method === "spf" && !spf) spf = result;
    else if (method === "dmarc" && dmarcResults++ === 0) {
      dmarc = result;
      const from = domainOf(prop("header.from"));
      if (result === "pass" && from) verified.add(from);
    } else if (method === "dkim") {
      dkim.push(result);
      const d = domainOf(prop("header.d") || prop("header.i"));
      if (result === "pass" && d) verified.add(d);
    }
  }
  return {
    spf,
    dkim: dkim.includes("pass") ? "pass" : (dkim[0] ?? ""),
    dmarc,
    verifiedDomains: [...verified].slice(0, 10),
    spamScore: null,
    dkimResults: dkim.length,
    dmarcResults,
  };
}

/** Number of header fields called `name` in a header section. */
function countHeaders(head: string, name: string): number {
  const want = name.toLowerCase() + ":";
  let n = 0;
  let lineStart = 0;
  while (lineStart < head.length) {
    let lineEnd = head.indexOf("\n", lineStart);
    if (lineEnd === -1) lineEnd = head.length;
    if (head.slice(lineStart, lineStart + want.length).toLowerCase() === want) n++;
    lineStart = lineEnd + 1;
  }
  return n;
}

/**
 * Verdicts for a stored message. Fails closed (no verdicts) whenever the header could have been
 * shaped by the sender: an envelope sender with structural characters; backslashes, or
 * unbalanced quotes or comments in the header; more dkim= results than the message has DKIM-Signature headers
 * (Cloudflare writes one per signature, or a single dkim=none); or more than one dmarc= result.
 * Sender-controlled text (envelope sender, HELO) only appears in Cloudflare's spf entries, so an
 * injected result always shows up as one result too many.
 */
export function authVerdicts(raw: Uint8Array, envelopeFrom: string): AuthVerdicts {
  // Informational only: Cloudflare adds this at the top, but a sender could add one further down.
  const head = headerSection(raw);
  const score = Number.parseInt(firstHeader(head, "x-cf-spamh-score") ?? "", 10);
  const spamScore = Number.isFinite(score) ? score : null;
  if (UNSAFE_ENVELOPE.test(envelopeFrom)) return { ...NO_VERDICTS, spamScore };
  const { dkimResults, dmarcResults, ...v } = parseAuthResults(firstHeader(head, "authentication-results"));
  if (dmarcResults > 1 || dkimResults > Math.max(1, countHeaders(head, "dkim-signature"))) return { ...NO_VERDICTS, spamScore };
  return { ...v, spamScore };
}
