// Two-phase ingest, shaped by the Workers Free plan's 10 ms CPU limit per invocation.
//
// Phase 1 runs in the email() handler and must never exceed the limit: if it did, the message
// would be lost and the sender could see a bounce. It parses headers only, gzips small mail,
// and stores the raw MIME with parse_status `pending`.
//
// Phase 2 (parseMessage) fills in text, codes, links and attachment metadata. It runs in a later
// invocation with its own CPU budget: the first read that returns the message, or the cron sweep.
// Each attempt is recorded before parsing starts, and the retry parses fewer bytes, so a message
// that keeps exhausting CPU ends up `failed` with its raw intact instead of looping.

import PostalMime, { addressParser, decodeWords } from "postal-mime";
import type { Address, Email } from "postal-mime";
import { extractCodes, extractLinkDetails, htmlToText, type LinkDetail } from "./extract";
import { authVerdicts } from "./authresults";
import { actionLink } from "./action";
import { isBulk, matchBlock, noteBlockHit } from "./bulk";
import { arrivalReserve, evictForSpace, insertMessage, loadRaw, META_RESERVE, noteStoreFailure, storedBytes, TEXT_RESERVE_MAX, utf8Bytes, type AttachmentMeta } from "./store";
import { gzip, intVar, newId } from "./util";

/** Leading bytes parsed on the first attempt. Text parts come first in nearly all mail. */
export const DEFAULT_PARSE_BYTES = 256 * 1024;
/** Bytes parsed on the second attempt, after the first ran out of CPU. */
export const RETRY_PARSE_BYTES = 64 * 1024;
export const MAX_PARSE_ATTEMPTS = 2;
/** Mail above this is stored uncompressed: gzip of large bodies costs several ms of CPU. */
export const DEFAULT_GZIP_MAX_BYTES = 128 * 1024;
/** Mail above this is stored truncated (headers and the first part of the body kept). */
export const DEFAULT_MAX_MESSAGE_KB = 4096;
export const DEFAULT_MAX_STORE_MB = 350;
/** Codes are looked for in at most this much of a subject; huge subjects cost CPU on arrival. */
const MAX_SUBJECT_SCAN = 1024;
/** Structural limits for every MIME parse. */
export const PARSE_LIMITS = { maxRfc822NestingDepth: 2, maxNestingDepth: 50, maxPartCount: 1000 } as const;
const MAX_TEXT_CHARS = 100_000;
/**
 * Header values are cut to this before parsing or storing. addressParser and decodeWords cost
 * CPU in proportion to length, and a 64 KB To header would otherwise blow the arrival budget.
 */
export const MAX_HEADER_CHARS = 2048;
/** Envelope addresses are matched exactly; nothing legitimate is longer. */
const MAX_ENVELOPE_CHARS = 512;
/** Caps on the parsed link and attachment lists, so their stored size is bounded and counted. */
const MAX_LINKS_JSON = 32 * 1024;
const MAX_ATTACHMENTS = 100;
const MAX_ATTACHMENT_FIELD = 256;
const MAX_ATTACHMENTS_JSON = 24 * 1024;

/** C0 controls and DEL removed, length capped: for sender-controlled strings we store. */
function clean(s: string | null | undefined, max: number): string {
  // eslint-disable-next-line no-control-regex
  return (s ?? "").slice(0, max * 2).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, max);
}

/** Longest prefix of `items` whose JSON fits in `maxBytes`. */
function fitJson<T>(items: T[], maxBytes: number): T[] {
  let size = 2;
  let n = 0;
  for (const item of items) {
    size += utf8Bytes(JSON.stringify(item)) + 1;
    if (size > maxBytes) break;
    n++;
  }
  return items.slice(0, n);
}

export function formatAddress(a: Address | undefined): string {
  if (!a) return "";
  if (a.group) return a.group.map((m) => m.address).join(", ");
  return a.name ? `${a.name} <${a.address}>` : a.address;
}

export interface HeaderSummary {
  headerFrom: string;
  headerTo: string;
  subject: string;
  messageId: string;
  sentAt: string;
}

function addresses(value: string | null): string {
  if (!value) return "";
  try {
    return addressParser(value).map(formatAddress).join(", ");
  } catch {
    return value;
  }
}

/**
 * Arrival-time header value. Plain values are kept as written (whitespace collapsed, and the
 * quotes around a leading display name dropped); only values with RFC 2047 encoded words ("=?")
 * go through postal-mime, whose first call in a fresh isolate costs a few ms of CPU. The parse
 * step later replaces all three with postal-mime's fully decoded values.
 */
function quickAddresses(value: string): string {
  if (value.includes("=?")) return addresses(value);
  const v = value.replace(/\s+/g, " ").trim();
  if (v.startsWith('"')) {
    const close = v.indexOf('"', 1);
    if (close > 0 && v.slice(close + 1).trimStart().startsWith("<")) return v.slice(1, close) + " " + v.slice(close + 1).trimStart();
  }
  return v;
}

/**
 * Cheap: uses the headers the runtime already parsed natively (`message.headers`), and only
 * decodes the few kept. About 100x less CPU than running the MIME parser over the header block.
 */
export function summarizeHeaders(headers: Headers): HeaderSummary {
  const get = (name: string) => (headers.get(name) ?? "").slice(0, MAX_HEADER_CHARS);
  let subject = get("subject");
  if (subject.includes("=?")) {
    try {
      subject = decodeWords(subject);
    } catch {
      // keep the raw value
    }
  }
  const date = get("date").slice(0, 128);
  const t = Date.parse(date);
  return {
    headerFrom: clean(quickAddresses(get("from")), MAX_HEADER_CHARS),
    headerTo: clean(quickAddresses(get("to")), MAX_HEADER_CHARS),
    subject: clean(subject, MAX_HEADER_CHARS),
    messageId: clean(get("message-id"), 512),
    sentAt: Number.isNaN(t) ? date : new Date(t).toISOString(),
  };
}

export interface BodySummary {
  /** Fully decoded From, To and Subject; absent when the parse failed. */
  headers?: { from: string; to: string; subject: string };
  text: string;
  hasHtml: boolean;
  codes: string[];
  links: LinkDetail[];
  attachments: AttachmentMeta[];
  parseStatus: "ok" | "partial" | "failed";
}

/** Full parse of up to `parseBytes` leading bytes. Never throws. */
export async function summarizeBody(raw: Uint8Array, parseBytes: number): Promise<BodySummary> {
  const truncated = raw.byteLength > parseBytes;
  let email: Email;
  try {
    email = await PostalMime.parse(truncated ? raw.subarray(0, parseBytes) : raw, {
      attachmentEncoding: "arraybuffer",
      ...PARSE_LIMITS,
    });
  } catch {
    return { text: "", hasHtml: false, codes: [], links: [], attachments: [], parseStatus: "failed" };
  }
  const html = email.html;
  const text = (email.text?.trim() ? email.text.trim() : html ? htmlToText(html) : "").slice(0, MAX_TEXT_CHARS);
  return {
    headers: {
      from: clean(formatAddress(email.from), MAX_HEADER_CHARS),
      to: clean((email.to ?? []).slice(0, 50).map(formatAddress).join(", "), MAX_HEADER_CHARS),
      subject: clean(email.subject ?? "", MAX_HEADER_CHARS),
    },
    text,
    hasHtml: Boolean(html),
    codes: extractCodes((email.subject ?? "").slice(0, MAX_SUBJECT_SCAN), text, email.otp?.code),
    links: fitJson(extractLinkDetails(text, html), MAX_LINKS_JSON),
    attachments: fitJson(
      email.attachments.slice(0, MAX_ATTACHMENTS).map((a) => ({
        filename: a.filename == null ? null : clean(a.filename, MAX_ATTACHMENT_FIELD),
        mime_type: clean(a.mimeType, MAX_ATTACHMENT_FIELD),
        size: typeof a.content === "string" ? a.content.length : a.content.byteLength,
        ...(a.contentId ? { content_id: clean(a.contentId, MAX_ATTACHMENT_FIELD) } : {}),
        inline: a.disposition === "inline" || a.related === true,
      })),
      MAX_ATTACHMENTS_JSON,
    ),
    parseStatus: truncated ? "partial" : "ok",
  };
}

/** Phase 1. Runs inside email(). */
export async function handleEmail(message: ForwardableEmailMessage, env: Env): Promise<void> {
  const now = Date.now();
  const h = summarizeHeaders(message.headers);
  const envelopeTo = message.to.toLowerCase().slice(0, MAX_ENVELOPE_CHARS);
  const bulk = isBulk(message.headers, h.subject);

  // Blocks first: blocked mail is rejected before it is read, and never stored or forwarded. The
  // bounce tells the sender the address is gone, so mailing lists drop it. A failed check stores
  // the mail as usual.
  try {
    const block = await matchBlock(env.DB, { to: envelopeTo, headerFrom: h.headerFrom, bulk });
    if (block) {
      message.setReject("This address does not accept this mail");
      await noteBlockHit(env.DB, block.id, now).catch(() => {});
      console.log(JSON.stringify({ event: "blocked", block: block.id }));
      return;
    }
  } catch (err) {
    console.error(JSON.stringify({ event: "block_check_failed", error: String(err) }));
  }

  // Native buffering; avoids a JS read loop and concat.
  const full = new Uint8Array(await new Response(message.raw).arrayBuffer());
  const maxMessage = intVar(env.MAX_MESSAGE_KB, DEFAULT_MAX_MESSAGE_KB, 64, 25 * 1024) * 1024;
  const raw = full.byteLength > maxMessage ? full.subarray(0, maxMessage) : full;
  const gzipMax = intVar(env.GZIP_MAX_BYTES, DEFAULT_GZIP_MAX_BYTES, 0, 25 * 1024 * 1024);
  const compress = raw.byteLength <= gzipMax;
  const stored = compress ? gzip(raw) : raw;
  const id = newId(now);

  try {
    // Enforce the size cap before writing, so a flood cannot overrun the database between
    // retention runs. Unread mail is evicted first (see evictForSpace).
    const cap = intVar(env.MAX_STORE_MB, DEFAULT_MAX_STORE_MB, 1) * 1024 * 1024;
    const over = (await storedBytes(env.DB)) + stored.byteLength + 4 * MAX_HEADER_CHARS + arrivalReserve(full.byteLength) - cap;
    if (over > 0) {
      const evicted = await evictForSpace(env.DB, over + Math.floor(cap * 0.02));
      console.log(JSON.stringify({ event: "evicted", ...evicted }));
    }
    await insertMessage(env.DB, {
      id,
      receivedAt: now,
      envelopeTo,
      envelopeFrom: clean(message.from, MAX_ENVELOPE_CHARS),
      ...h,
      // Codes come from the parse step (subject and body together); none at arrival.
      codes: [],
      auth: authVerdicts(raw, message.from),
      rawSize: full.byteLength,
      rawTruncated: raw !== full,
      stored,
      compressed: compress,
      bulk,
    });
    console.log(JSON.stringify({ event: "stored", id, raw_size: full.byteLength, stored_size: stored.byteLength }));
  } catch (err) {
    // Do not rethrow. A failing email() handler makes Cloudflare reject the message.
    console.error(JSON.stringify({ event: "store_failed", id, error: String(err) }));
    await noteStoreFailure(env.DB, now);
  }

  // Forwarded copies go out after the store, so they never delay or endanger it.
  const targets = (env.FORWARD_TO ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const target of targets) {
    try {
      await message.forward(target);
    } catch (err) {
      console.error(JSON.stringify({ event: "forward_failed", target, error: String(err) }));
    }
  }
}

/**
 * Phase 2 for one message. Returns false if it was not pending (already parsed, or another
 * invocation claimed it first).
 *
 * `firstAttemptOnly` is used from read requests: a message whose first parse already died is
 * left to the cron, so a hostile message can cost at most one agent request, never a stream.
 */
export async function parseMessage(env: Env, id: string, opts: { firstAttemptOnly?: boolean } = {}): Promise<boolean> {
  // Claiming a deferred message turns it into a pending one and adds the parse reserve it did
  // not hold at arrival, so the reserve swap below stays exact. If this parse dies, the cron
  // retries it like any other pending message (bounded by MAX_PARSE_ATTEMPTS).
  const claim = await env.DB.prepare(
    `UPDATE messages SET parse_attempts = parse_attempts + 1,
       stored_size = stored_size + CASE WHEN parse_status = 'deferred' THEN MIN(raw_size, ?2) + ?3 ELSE 0 END,
       parse_status = 'pending'
     WHERE id = ?1 AND parse_status IN ('pending', 'deferred') ${opts.firstAttemptOnly ? "AND parse_attempts = 0" : ""}
     RETURNING parse_attempts`,
  )
    .bind(id, TEXT_RESERVE_MAX, META_RESERVE)
    .first<{ parse_attempts: number }>();
  if (!claim) return false;

  if (claim.parse_attempts > MAX_PARSE_ATTEMPTS) {
    await env.DB.prepare(`UPDATE messages SET parse_status = 'failed' WHERE id = ?1`).bind(id).run();
    console.error(JSON.stringify({ event: "parse_gave_up", id }));
    return true;
  }
  const raw = await loadRaw(env.DB, id);
  if (!raw) return false;
  const first = intVar(env.PARSE_BYTES, DEFAULT_PARSE_BYTES, 16 * 1024, 25 * 1024 * 1024);
  const b = await summarizeBody(raw, claim.parse_attempts === 1 ? first : Math.min(first, RETRY_PARSE_BYTES));
  const codes = JSON.stringify(b.codes);
  const links = JSON.stringify(b.links);
  const attachments = JSON.stringify(b.attachments);
  // Swap the insert-time reserve for the real size of everything the parse wrote. The codes
  // column was already counted at insert, so only its growth is added.
  const parsedBytes = utf8Bytes(b.text) + utf8Bytes(links) + utf8Bytes(attachments);
  // A parse that read headers replaces the arrival-time From, To and Subject with decoded values;
  // the size counter moves by exactly the difference. Empty decoded values keep the arrival ones.
  const h = b.headers;
  await env.DB.prepare(
    `UPDATE messages SET text = ?2, has_html = ?3, links = ?5, attachments = ?6, parse_status = ?7,
       stored_size = stored_size - (MIN(raw_size, ?9) + ?10) + ?8 + MAX(0, length(CAST(?4 AS BLOB)) - length(CAST(codes AS BLOB)))
         + CASE WHEN ?11 = '' THEN 0 ELSE length(CAST(?11 AS BLOB)) - length(CAST(header_from AS BLOB)) END
         + CASE WHEN ?12 = '' THEN 0 ELSE length(CAST(?12 AS BLOB)) - length(CAST(header_to AS BLOB)) END
         + CASE WHEN ?13 = '' THEN 0 ELSE length(CAST(?13 AS BLOB)) - length(CAST(subject AS BLOB)) END,
       codes = ?4,
       header_from = CASE WHEN ?11 = '' THEN header_from ELSE ?11 END,
       header_to = CASE WHEN ?12 = '' THEN header_to ELSE ?12 END,
       subject = CASE WHEN ?13 = '' THEN subject ELSE ?13 END,
       has_action = ?14
     WHERE id = ?1`,
  )
    .bind(id, b.text, b.hasHtml ? 1 : 0, codes, links, attachments, b.parseStatus, parsedBytes, TEXT_RESERVE_MAX, META_RESERVE, h?.from ?? "", h?.to ?? "", h?.subject ?? "", actionLink(b.links) ? 1 : 0)
    .run();
  return true;
}

/**
 * Parse pending messages, oldest first, until about `byteBudget` raw bytes have been handled.
 * With `deferred`, the rest of the run then takes deferred (big) mail, newest first, so the
 * latest mail gets its codes first (CRON_PARSE_DEFERRED; best on Workers Paid, where a run has
 * the CPU for it).
 */
export async function parsePending(env: Env, byteBudget: number, maxMessages = 20, deferred = false): Promise<number> {
  let { results } = await env.DB.prepare(
    `SELECT id, raw_size FROM messages WHERE parse_status = 'pending' ORDER BY received_at LIMIT ?1`,
  )
    .bind(maxMessages)
    .all<{ id: string; raw_size: number }>();
  if (deferred && results.length < maxMessages) {
    const more = await env.DB.prepare(
      `SELECT id, raw_size FROM messages WHERE parse_status = 'deferred' ORDER BY received_at DESC LIMIT ?1`,
    )
      .bind(maxMessages - results.length)
      .all<{ id: string; raw_size: number }>();
    results = results.concat(more.results);
  }
  const perMessage = (size: number) => Math.min(size, intVar(env.PARSE_BYTES, DEFAULT_PARSE_BYTES, 16 * 1024));
  let spent = 0;
  let done = 0;
  for (const r of results) {
    if (done > 0 && spent + perMessage(r.raw_size) > byteBudget) break;
    if (await parseMessage(env, r.id)) done++;
    spent += perMessage(r.raw_size);
  }
  return done;
}
