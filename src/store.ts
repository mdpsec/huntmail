import { actionLink, type ActionLink, type LinkKind, linkKind } from "./action";
import { fromDomain } from "./bulk";
import { decodeLeftoverEntities, type LinkDetail } from "./extract";
import { concatBytes, gunzip } from "./util";

/** D1 caps a row or blob at 2 MB. Keep chunks well under. */
export const CHUNK_BYTES = 1_000_000;
/** D1 allows 100 bound parameters per statement. */
const MAX_BINDS = 90;

export interface AuthVerdicts {
  spf: string;
  dkim: string;
  dmarc: string;
  /** Domains with a passing DKIM signature, plus the From domain when DMARC passed. */
  verifiedDomains: string[];
  spamScore: number | null;
}

export interface NewMessage {
  id: string;
  receivedAt: number;
  envelopeTo: string;
  envelopeFrom: string;
  headerFrom: string;
  headerTo: string;
  subject: string;
  messageId: string;
  sentAt: string;
  codes: string[];
  auth: AuthVerdicts;
  rawSize: number;
  rawTruncated: boolean;
  stored: Uint8Array;
  compressed: boolean;
  /** Newsletter headers and a subject that does not look like account mail (see bulk.ts). */
  bulk: boolean;
}

export interface AttachmentMeta {
  filename: string | null;
  mime_type: string;
  size: number;
  content_id?: string;
  inline: boolean;
}

interface Row {
  id: string;
  received_at: number;
  envelope_to: string;
  envelope_from: string;
  header_from: string;
  header_to: string;
  subject: string;
  message_id: string;
  sent_at: string;
  text?: string;
  has_html: number;
  codes: string;
  /** Absent in light list queries. */
  links?: string;
  attachments?: string;
  raw_size: number;
  raw_truncated: number;
  stored_size: number;
  compressed: number;
  chunk_count: number;
  parse_status: string;
  auth_spf: string;
  auth_dkim: string;
  auth_dmarc: string;
  verified_domains: string;
  spam_score: number | null;
  bulk: number;
  has_action: number;
}

export interface MessageOut {
  id: string;
  received_at: string;
  to: string;
  from: string;
  header_from: string;
  header_to: string;
  subject: string;
  message_id: string;
  sent_at: string;
  text?: string;
  has_html: boolean;
  codes: string[];
  links: string[];
  /**
   * Each link with its visible text ("" for links found in plain text) and its kind: "action",
   * "unsubscribe", "view", "social", "app", "legal", "support", "image", or "" for content.
   */
  link_details: (LinkDetail & { kind: LinkKind })[];
  /** The link the mail is about (verify, reset, sign in, invite), from link_details; null without one. */
  action: ActionLink | null;
  attachments: AttachmentMeta[];
  auth: { spf: string; dkim: string; dmarc: string; verified_domains: string[]; spam_score: number | null };
  raw_size: number;
  raw_truncated: boolean;
  parse_status: string;
  /** Newsletter headers, parsed, no code and no action link: hidden by `newsletters=hide`. */
  newsletter: boolean;
  /** The From header's domain, lowercased ("" without one): the value a sender block takes. */
  sender_domain: string;
}

/** Links are stored as `{url, text}` objects; plain URL strings are accepted too. */
function linkDetails(json: string): LinkDetail[] {
  return (JSON.parse(json) as (string | LinkDetail)[]).map((l) => (typeof l === "string" ? { url: l, text: "" } : l));
}

export function toOut(r: Row): MessageOut {
  // Text parsed before the wider entity table may still hold &emsp; and the like.
  const details = linkDetails(r.links ?? "[]").map((l) => ({ url: l.url, text: decodeLeftoverEntities(l.text) }));
  const action = actionLink(details);
  const out: MessageOut = {
    id: r.id,
    received_at: new Date(r.received_at).toISOString(),
    to: r.envelope_to,
    from: r.envelope_from,
    header_from: r.header_from,
    header_to: r.header_to,
    subject: r.subject,
    message_id: r.message_id,
    sent_at: r.sent_at,
    has_html: r.has_html === 1,
    codes: JSON.parse(r.codes) as string[],
    links: details.map((l) => l.url),
    link_details: details.map((l) => ({ ...l, kind: linkKind(l, action) })),
    action,
    attachments: JSON.parse(r.attachments ?? "[]") as AttachmentMeta[],
    auth: {
      spf: r.auth_spf || "none",
      dkim: r.auth_dkim || "none",
      dmarc: r.auth_dmarc || "none",
      verified_domains: r.verified_domains.split(",").filter(Boolean),
      spam_score: r.spam_score,
    },
    raw_size: r.raw_size,
    raw_truncated: r.raw_truncated === 1,
    parse_status: r.parse_status,
    newsletter: r.bulk === 1 && r.has_action === 0 && r.codes === "[]" && (r.parse_status === "ok" || r.parse_status === "partial"),
    sender_domain: fromDomain(r.header_from),
  };
  if (r.text !== undefined) out.text = decodeLeftoverEntities(r.text);
  return out;
}

/** UTF-8 bytes of a string, as SQLite stores it. */
export function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** Fixed per-row overhead counted on top of the actual field bytes (ids, numbers, row header). */
const ROW_OVERHEAD = 256;

export async function insertMessage(db: D1Database, m: NewMessage): Promise<void> {
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < m.stored.byteLength || i === 0; i += CHUNK_BYTES) {
    chunks.push(m.stored.subarray(i, i + CHUNK_BYTES));
  }
  const verified = "," + m.auth.verifiedDomains.join(",") + (m.auth.verifiedDomains.length ? "," : "");
  const codes = JSON.stringify(m.codes);
  // Count every stored field, plus a reserve for what the later parse adds (text, links,
  // attachment list), so the size cap holds before and after parsing. Deferred mail holds no
  // reserve; the parse claim adds it (see parseMessage).
  const fields = [m.envelopeTo, m.envelopeFrom, m.headerFrom, m.headerTo, m.subject, m.messageId, m.sentAt, codes, verified];
  const storedSize = m.stored.byteLength + ROW_OVERHEAD + fields.reduce((n, f) => n + utf8Bytes(f), 0) + arrivalReserve(m.rawSize);
  const statements = [
    db
      .prepare(
        `INSERT INTO messages (id, received_at, envelope_to, envelope_from, header_from, header_to, subject,
          message_id, sent_at, codes, raw_size, stored_size, compressed, chunk_count, raw_truncated,
          auth_spf, auth_dkim, auth_dmarc, verified_domains, spam_score, parse_status, bulk)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21, ?22)`,
      )
      .bind(
        m.id,
        m.receivedAt,
        m.envelopeTo,
        m.envelopeFrom,
        m.headerFrom,
        m.headerTo,
        m.subject,
        m.messageId,
        m.sentAt,
        codes,
        m.rawSize,
        storedSize,
        m.compressed ? 1 : 0,
        chunks.length,
        m.rawTruncated ? 1 : 0,
        m.auth.spf,
        m.auth.dkim,
        m.auth.dmarc,
        verified,
        m.auth.spamScore,
        arrivalStatus(m.rawSize),
        m.bulk ? 1 : 0,
      ),
    ...chunks.map((c, seq) =>
      db.prepare(`INSERT INTO raw_chunks (message_id, seq, data) VALUES (?1, ?2, ?3)`).bind(m.id, seq, c),
    ),
  ];
  await db.batch(statements);
}

/** Bytes reserved per message for parsed text (see MAX_TEXT_CHARS in ingest). */
export const TEXT_RESERVE_MAX = 100_000;
/**
 * Bytes reserved per message for the parsed links, attachment list and codes. Each is capped
 * when it is built (see MAX_LINKS_JSON and MAX_ATTACHMENTS_JSON in ingest), so this covers them.
 */
export const META_RESERVE = 64 * 1024;
/** Reserve held from insert until the parse replaces it with the real byte counts. */
export function parseReserve(rawSize: number): number {
  return Math.min(rawSize, TEXT_RESERVE_MAX) + META_RESERVE;
}

/**
 * Mail up to this size is parsed in the background (cron, list reads). Bigger mail arrives as
 * `deferred` and is parsed only when something reads it: by id, through the UI, or through a
 * wait. Account mail (codes, verify links) is small; the big ones are mostly newsletters.
 */
export const BACKGROUND_PARSE_MAX_BYTES = 64 * 1024;

export function arrivalStatus(rawSize: number): "pending" | "deferred" {
  return rawSize > BACKGROUND_PARSE_MAX_BYTES ? "deferred" : "pending";
}

/** Reserve counted at arrival: deferred mail holds none until a read claims it for parsing. */
export function arrivalReserve(rawSize: number): number {
  return arrivalStatus(rawSize) === "deferred" ? 0 : parseReserve(rawSize);
}

export interface ListQuery {
  to?: string;
  /**
   * Recipient starts with this (lowercase ASCII, validated by the caller): all mail for a family
   * of addresses such as `acme-` or `acme-1731942000-`. An index range, not a LIKE scan.
   */
  toPrefix?: string;
  /** Recipient domain, exact (lowercase, validated by the caller). Uses messages_to_domain_time. */
  toDomain?: string;
  /** Leave newsletters out, or list only them (see NEWSLETTER_SQL). */
  newsletters?: "hide" | "only";
  subject?: string;
  q?: string;
  /** Only mail with a passing DKIM signature (or DMARC pass) for this domain or a subdomain of it. */
  fromDomain?: string;
  since?: number;
  before?: number;
  /** Keyset cursor: rows strictly older than this (received_at, id), i.e. the next page. */
  cursor?: { at: number; id: string };
  limit: number;
  withText: boolean;
  /** Skip the links and attachment lists (the inbox list does not show them). */
  light?: boolean;
  order: "asc" | "desc";
}

const LIGHT_COLS = `id, received_at, envelope_to, envelope_from, header_from, header_to, subject, message_id, sent_at,
  has_html, codes, raw_size, raw_truncated, stored_size, compressed, chunk_count, parse_status,
  auth_spf, auth_dkim, auth_dmarc, verified_domains, spam_score, bulk, has_action`;
const SUMMARY_COLS = `${LIGHT_COLS}, links, attachments`;

/**
 * A newsletter: bulk at arrival, parsed, and no code and no action link. The same text as the
 * messages_newsletter index (migration 0009), so SQLite can use it.
 */
export const NEWSLETTER_SQL = `bulk = 1 AND has_action = 0 AND codes = '[]' AND parse_status IN ('ok', 'partial')`;

function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (c) => "\\" + c);
}

function whereClause(q: Omit<ListQuery, "limit" | "withText" | "order">): { sql: string; args: unknown[] } {
  const where: string[] = [];
  const args: unknown[] = [];
  if (q.to) {
    where.push(`envelope_to = ?`);
    args.push(q.to.toLowerCase());
  }
  if (q.toPrefix) {
    // [prefix, prefix with its last character + 1): every string that starts with the prefix.
    const p = q.toPrefix;
    where.push(`envelope_to >= ? AND envelope_to < ?`);
    args.push(p, p.slice(0, -1) + String.fromCharCode(p.charCodeAt(p.length - 1) + 1));
  }
  if (q.toDomain) {
    // The same expression as the messages_to_domain_time index, so SQLite uses it.
    where.push(`substr(envelope_to, instr(envelope_to, '@') + 1) = ?`);
    args.push(q.toDomain);
  }
  if (q.newsletters) {
    where.push(q.newsletters === "only" ? NEWSLETTER_SQL : `NOT (${NEWSLETTER_SQL})`);
  }
  if (q.subject) {
    where.push(`subject LIKE ? ESCAPE '\\'`);
    args.push("%" + likeEscape(q.subject) + "%");
  }
  if (q.q) {
    const like = "%" + likeEscape(q.q) + "%";
    where.push(
      `(subject LIKE ? ESCAPE '\\' OR header_from LIKE ? ESCAPE '\\' OR header_to LIKE ? ESCAPE '\\' OR envelope_from LIKE ? ESCAPE '\\')`,
    );
    args.push(like, like, like, like);
  }
  if (q.fromDomain) {
    const d = likeEscape(q.fromDomain.toLowerCase().replace(/^\.+|\.+$/g, ""));
    where.push(`(verified_domains LIKE ? ESCAPE '\\' OR verified_domains LIKE ? ESCAPE '\\')`);
    args.push(`%,${d},%`, `%.${d},%`);
  }
  if (q.since !== undefined) {
    where.push(`received_at > ?`);
    args.push(q.since);
  }
  if (q.before !== undefined) {
    where.push(`received_at < ?`);
    args.push(q.before);
  }
  if (q.cursor) {
    where.push(`(received_at < ? OR (received_at = ? AND id < ?))`);
    args.push(q.cursor.at, q.cursor.at, q.cursor.id);
  }
  return { sql: where.length ? "WHERE " + where.join(" AND ") : "", args };
}

/** Opaque page cursor "<received_at ms>.<id>" for the oldest row of a full page; null when done. */
export function nextCursor(rows: MessageOut[], limit: number): string | null {
  if (rows.length < limit) return null;
  const oldest = rows.reduce((a, b) => (b.received_at < a.received_at || (b.received_at === a.received_at && b.id < a.id) ? b : a));
  return `${Date.parse(oldest.received_at)}.${oldest.id}`;
}

export function parseCursor(s: string | null | undefined): { at: number; id: string } | null {
  const m = s?.match(/^(\d{1,15})\.([0-9a-f]{28})$/);
  return m ? { at: Number(m[1]), id: m[2]! } : null;
}

/**
 * The newest `limit` matches. `order` only sets the order they are returned in; `asc` (newest
 * last, so callers take the last element) is the simple `/emails` list's.
 */
export async function listMessages(db: D1Database, q: ListQuery): Promise<MessageOut[]> {
  const w = whereClause(q);
  const sql = `SELECT ${q.light ? LIGHT_COLS : SUMMARY_COLS}${q.withText ? ", text" : ""} FROM messages ${w.sql}
    ORDER BY received_at DESC, id DESC LIMIT ${Math.trunc(q.limit)}`;
  const { results } = await db.prepare(sql).bind(...w.args).all<Row>();
  const rows = results.map(toOut);
  return q.order === "asc" ? rows.reverse() : rows;
}

export async function countMessages(db: D1Database, q: Omit<ListQuery, "limit" | "withText" | "order">): Promise<number> {
  const w = whereClause(q);
  return (await db.prepare(`SELECT COUNT(*) AS n FROM messages ${w.sql}`).bind(...w.args).first<{ n: number }>())?.n ?? 0;
}

export async function getMessage(db: D1Database, id: string): Promise<(MessageOut & { compressed: boolean; chunk_count: number }) | null> {
  const row = await db.prepare(`SELECT ${SUMMARY_COLS}, text FROM messages WHERE id = ?1`).bind(id).first<Row>();
  if (!row) return null;
  return { ...toOut(row), compressed: row.compressed === 1, chunk_count: row.chunk_count };
}

function chunked<T>(xs: T[], size = MAX_BINDS): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < xs.length; i += size) out.push(xs.slice(i, i + size));
  return out;
}

/** Records the first read. Unread mail is what gets evicted first when space runs out. */
export async function markRead(db: D1Database, ids: string[], now = Date.now()): Promise<void> {
  for (const part of chunked(ids)) {
    const marks = part.map((_, i) => `?${i + 2}`).join(",");
    await db.prepare(`UPDATE messages SET read_at = ?1 WHERE read_at IS NULL AND id IN (${marks})`).bind(now, ...part).run();
  }
}

/** Stored bytes as written (gzip or plain), reassembled from chunks. */
export async function getStoredRaw(db: D1Database, id: string): Promise<{ data: Uint8Array; compressed: boolean } | null> {
  const meta = await db.prepare(`SELECT compressed FROM messages WHERE id = ?1`).bind(id).first<{ compressed: number }>();
  if (!meta) return null;
  const { results } = await db
    .prepare(`SELECT data FROM raw_chunks WHERE message_id = ?1 ORDER BY seq`)
    .bind(id)
    .all<{ data: ArrayBuffer | number[] }>();
  const parts = results.map((r) => (r.data instanceof ArrayBuffer ? new Uint8Array(r.data) : Uint8Array.from(r.data)));
  return { data: concatBytes(parts), compressed: meta.compressed === 1 };
}

/** Original raw MIME bytes (or the stored head of it, when `raw_truncated`). */
export async function loadRaw(db: D1Database, id: string): Promise<Uint8Array | null> {
  const stored = await getStoredRaw(db, id);
  if (!stored) return null;
  return stored.compressed ? gunzip(stored.data) : stored.data;
}

/** Raw MIME for several messages. Missing ids are absent from the map. */
export async function loadRawMany(db: D1Database, ids: string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const part of chunked(ids)) {
    const marks = part.map((_, i) => `?${i + 1}`).join(",");
    const [meta, chunks] = await db.batch<{ id?: string; compressed?: number; message_id?: string; seq?: number; data?: ArrayBuffer | number[] }>([
      db.prepare(`SELECT id, compressed FROM messages WHERE id IN (${marks})`).bind(...part),
      db.prepare(`SELECT message_id, seq, data FROM raw_chunks WHERE message_id IN (${marks}) ORDER BY message_id, seq`).bind(...part),
    ]);
    const parts = new Map<string, Uint8Array[]>();
    for (const c of chunks!.results) {
      const d = c.data instanceof ArrayBuffer ? new Uint8Array(c.data) : Uint8Array.from(c.data ?? []);
      const list = parts.get(c.message_id!) ?? [];
      list.push(d);
      parts.set(c.message_id!, list);
    }
    for (const m of meta!.results) {
      const data = concatBytes(parts.get(m.id!) ?? []);
      out.set(m.id!, m.compressed === 1 ? gunzip(data) : data);
    }
  }
  return out;
}

// --- Space accounting and retention ---------------------------------------------------------

export async function metaValue(db: D1Database, key: string): Promise<number> {
  return (await db.prepare(`SELECT v FROM meta WHERE k = ?1`).bind(key).first<{ v: number }>())?.v ?? 0;
}

/** Running total kept by triggers on `messages`; no table scan. */
export function storedBytes(db: D1Database): Promise<number> {
  return metaValue(db, "stored_bytes");
}

/** Best effort: if D1 itself is failing this fails too, and the error log is the only trace. */
export async function noteStoreFailure(db: D1Database, now = Date.now()): Promise<void> {
  try {
    await db.batch([
      db.prepare(`UPDATE meta SET v = v + 1 WHERE k = 'store_failures'`),
      db.prepare(`UPDATE meta SET v = ?1 WHERE k = 'last_store_failure'`).bind(now),
    ]);
  } catch {
    // nothing more to do
  }
}

async function deleteIds(db: D1Database, ids: string[]): Promise<void> {
  for (const part of chunked(ids)) {
    const marks = part.map((_, i) => `?${i + 1}`).join(",");
    await db.batch([
      db.prepare(`DELETE FROM raw_chunks WHERE message_id IN (${marks})`).bind(...part),
      db.prepare(`DELETE FROM messages WHERE id IN (${marks})`).bind(...part),
    ]);
  }
}

/**
 * Frees at least `bytes`. Unread mail goes first, oldest first, then read mail oldest first. A
 * flood of junk nobody reads is therefore evicted before mail an agent or person has looked at.
 */
export async function evictForSpace(db: D1Database, bytes: number, maxRounds = 20): Promise<{ deleted: number; freed: number }> {
  let freed = 0;
  let deleted = 0;
  // Newsletters go first, oldest first; then unread mail, then read mail.
  let newsletters = true;
  for (let round = 0; round < maxRounds && freed < bytes; round++) {
    const { results } = await db
      .prepare(
        newsletters
          ? `SELECT id, stored_size FROM messages WHERE ${NEWSLETTER_SQL} ORDER BY received_at LIMIT 200`
          : `SELECT id, stored_size FROM messages ORDER BY (read_at IS NOT NULL), received_at LIMIT 200`,
      )
      .all<{ id: string; stored_size: number }>();
    if (!results.length) {
      if (!newsletters) break;
      newsletters = false;
      continue;
    }
    const ids: string[] = [];
    for (const r of results) {
      if (freed >= bytes) break;
      ids.push(r.id);
      freed += r.stored_size;
    }
    await deleteIds(db, ids);
    deleted += ids.length;
  }
  return { deleted, freed };
}

export interface RetentionResult {
  expired: number;
  /** Newsletters past NEWSLETTER_RETENTION_DAYS. */
  newsletters: number;
  trimmed: number;
  stored_bytes: number;
}

const DELETE_BATCH = 500;

async function deleteOlderThan(db: D1Database, cutoff: number, maxLoops = 40, only = ""): Promise<number> {
  let total = 0;
  for (let i = 0; i < maxLoops; i++) {
    const { results } = await db
      .prepare(`SELECT id FROM messages WHERE ${only ? `${only} AND ` : ""}received_at < ?1 ORDER BY received_at LIMIT ${DELETE_BATCH}`)
      .bind(cutoff)
      .all<{ id: string }>();
    if (!results.length) break;
    await deleteIds(db, results.map((r) => r.id));
    total += results.length;
    if (results.length < DELETE_BATCH) break;
  }
  return total;
}

export async function enforceRetention(
  db: D1Database,
  retentionDays: number,
  maxStoreBytes: number,
  now = Date.now(),
  newsletterDays = 0,
): Promise<RetentionResult> {
  const expired = retentionDays > 0 ? await deleteOlderThan(db, now - retentionDays * 86_400_000) : 0;
  const newsletters =
    newsletterDays > 0 && (retentionDays === 0 || newsletterDays < retentionDays)
      ? await deleteOlderThan(db, now - newsletterDays * 86_400_000, 40, NEWSLETTER_SQL)
      : 0;
  let trimmed = 0;
  const total = await storedBytes(db);
  if (maxStoreBytes > 0 && total > maxStoreBytes) trimmed = (await evictForSpace(db, total - maxStoreBytes)).deleted;
  const keepFrom = new Date(now - DAILY_STATS_KEEP_DAYS * 86_400_000).toISOString().slice(0, 10);
  await db.batch([
    db.prepare(`DELETE FROM daily_stats WHERE day < ?1`).bind(keepFrom),
    db.prepare(`DELETE FROM domain_daily WHERE day < ?1`).bind(keepFrom),
  ]);
  return { expired, newsletters, trimmed, stored_bytes: await storedBytes(db) };
}

// Stats. Every query here reads a handful of rows (meta counters, index endpoints, partial
// indexes, the daily tally), so the stats page and /api/stats stay cheap even when polled.

export interface Overview {
  messages: number;
  storedBytes: number;
  oldest: number | null;
  newest: number | null;
  pending: number;
  /** Big mail not parsed yet (parsed when read, or by the cron with CRON_PARSE_DEFERRED). */
  deferred: number;
  /** Newsletters stored now (NEWSLETTER_SQL). */
  newsletters: number;
  /** Mail rejected by a block, ever. */
  blocked: number;
  failed: number;
  storeFailures: number;
  lastStoreFailure: number;
}

/** Newsletters stored now; reads the messages_newsletter partial index only. */
export async function newsletterCount(db: D1Database): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE ${NEWSLETTER_SQL}`).first<{ c: number }>())?.c ?? 0;
}

export async function overview(db: D1Database): Promise<Overview> {
  const [counters, oldest, newest, pending, deferred, newsletters, blocked, failed, failures, lastFailure] = await db.batch([
    db.prepare(`SELECT v, n FROM meta WHERE k = 'stored_bytes'`),
    db.prepare(`SELECT MIN(received_at) AS t FROM messages`),
    db.prepare(`SELECT MAX(received_at) AS t FROM messages`),
    db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE parse_status = 'pending'`),
    db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE parse_status = 'deferred'`),
    db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE ${NEWSLETTER_SQL}`),
    db.prepare(`SELECT v FROM meta WHERE k = 'blocked'`),
    db.prepare(`SELECT COUNT(*) AS c FROM messages WHERE parse_status = 'failed'`),
    db.prepare(`SELECT v FROM meta WHERE k = 'store_failures'`),
    db.prepare(`SELECT v FROM meta WHERE k = 'last_store_failure'`),
  ]);
  const first = <T>(r: D1Result | undefined) => (r?.results?.[0] as T | undefined);
  return {
    messages: first<{ n: number }>(counters)?.n ?? 0,
    storedBytes: first<{ v: number }>(counters)?.v ?? 0,
    oldest: first<{ t: number | null }>(oldest)?.t ?? null,
    newest: first<{ t: number | null }>(newest)?.t ?? null,
    pending: first<{ c: number }>(pending)?.c ?? 0,
    deferred: first<{ c: number }>(deferred)?.c ?? 0,
    newsletters: first<{ c: number }>(newsletters)?.c ?? 0,
    blocked: first<{ v: number }>(blocked)?.v ?? 0,
    failed: first<{ c: number }>(failed)?.c ?? 0,
    storeFailures: first<{ v: number }>(failures)?.v ?? 0,
    lastStoreFailure: first<{ v: number }>(lastFailure)?.v ?? 0,
  };
}

export interface DayCount {
  day: string;
  received: number;
  rawBytes: number;
}

/** The last `days` UTC days ending today, oldest first, with zero-filled gaps. */
export async function dailyCounts(db: D1Database, days: number, now = Date.now()): Promise<DayCount[]> {
  const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
  const from = dayOf(now - (days - 1) * 86_400_000);
  const { results } = await db
    .prepare(`SELECT day, received, raw_bytes FROM daily_stats WHERE day >= ?1 ORDER BY day`)
    .bind(from)
    .all<{ day: string; received: number; raw_bytes: number }>();
  const byDay = new Map(results.map((r) => [r.day, r]));
  const out: DayCount[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = dayOf(now - i * 86_400_000);
    const r = byDay.get(day);
    out.push({ day, received: r?.received ?? 0, rawBytes: r?.raw_bytes ?? 0 });
  }
  return out;
}

export interface TopEntry {
  key: string;
  count: number;
}

/** Most common recipients and sender domains among the newest `sample` messages. */
export async function recentTop(db: D1Database, sample = 500, limit = 8): Promise<{ sample: number; recipients: TopEntry[]; senders: TopEntry[] }> {
  const { results } = await db
    .prepare(`SELECT envelope_to, header_from, envelope_from FROM messages ORDER BY received_at DESC LIMIT ?1`)
    .bind(sample)
    .all<{ envelope_to: string; header_from: string; envelope_from: string }>();
  const tally = (keys: string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) if (k) m.set(k, (m.get(k) ?? 0) + 1);
    return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([key, count]) => ({ key, count }));
  };
  const domain = (from: string) => {
    const s = from.endsWith(">") ? from.slice(from.lastIndexOf("<") + 1, -1) : from;
    const at = s.lastIndexOf("@");
    return at === -1 ? "" : s.slice(at + 1).toLowerCase();
  };
  return {
    sample: results.length,
    recipients: tally(results.map((r) => r.envelope_to)),
    senders: tally(results.map((r) => domain(r.header_from || r.envelope_from))),
  };
}

export interface DomainCount {
  domain: string;
  /** Messages in the window (see domainCounts). */
  received: number;
  today: number;
}

/**
 * Messages per recipient domain over the last `days` UTC days, most first, from the per-domain
 * daily tally (a few rows per day, never the messages table).
 */
export interface DomainDay {
  day: string;
  domain: string;
  received: number;
}

/** Mail per recipient domain per UTC day over the last `days` days, days with mail only, by day then domain. */
export async function domainDays(db: D1Database, days: number, now = Date.now()): Promise<DomainDay[]> {
  const from = new Date(now - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const { results } = await db
    .prepare(`SELECT day, domain, received FROM domain_daily WHERE day >= ?1 ORDER BY day, domain`)
    .bind(from)
    .all<DomainDay>();
  return results;
}

export async function domainCounts(db: D1Database, days: number, now = Date.now(), limit = 50): Promise<DomainCount[]> {
  const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
  const { results } = await db
    .prepare(
      `SELECT domain, SUM(received) AS received, SUM(CASE WHEN day = ?2 THEN received ELSE 0 END) AS today
       FROM domain_daily WHERE day >= ?1 GROUP BY domain ORDER BY received DESC, domain LIMIT ?3`,
    )
    .bind(dayOf(now - (days - 1) * 86_400_000), dayOf(now), limit)
    .all<DomainCount>();
  return results;
}

/** Daily tally rows older than this many days are dropped by the hourly retention run. */
export const DAILY_STATS_KEEP_DAYS = 400;
