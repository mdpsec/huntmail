import { clearSession, hasApiKey, hasSession, keyConfigured, logAuthFailure, makeSession, safeEqual, signView, verifyView } from "./auth";
import { DEFAULT_MAX_STORE_MB, DEFAULT_PARSE_BYTES, handleEmail, parseMessage, parsePending } from "./ingest";
import {
  countMessages,
  enforceRetention,
  getMessage,
  listMessages,
  loadRaw,
  loadRawMany,
  markRead,
  DAILY_STATS_KEEP_DAYS,
  dailyCounts,
  domainCounts,
  domainDays,
  newsletterCount,
  nextCursor,
  overview,
  recentTop,
  parseCursor,
  storedBytes,
  type ListQuery,
  type MessageOut,
} from "./store";
import { FAVICON_SVG, inboxPage, loginPage, messagePage, statsPage, UI_JS, uiCsp } from "./ui";
import { bodyCsp, findCid, outerCsp, parseFull, renderBodyHtml, renderViewPage } from "./view";
import { errorJson, escapeHtml as e, intVar, json, listVar, parseTime, toHex } from "./util";
import { addBlock, countBlocks, listBlocks, MAX_BLOCKS, parseBlock, removeBlock } from "./bulk";
import { themeAttrs } from "./theme";
import { VERSION } from "./version";

const ID_RE = /^[0-9a-f]{28}$/;
const BASE_HEADERS = { "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-robots-tag": "noindex, nofollow" };

/**
 * Every route lives under /<BASE_PATH>/, a random secret set at deploy. Anything else, including
 * the root, gets the same bare 404, so crawlers and scanners see nothing to probe.
 */
const BASE_PATH_RE = /^[A-Za-z0-9_-]{16,128}$/;

function basePath(env: Env): string | null {
  if (env.BASE_PATH && BASE_PATH_RE.test(env.BASE_PATH)) return env.BASE_PATH;
  console.error(JSON.stringify({ event: "base_path_missing" }));
  return null;
}

function notFound(): Response {
  return new Response("Not Found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8", ...BASE_HEADERS } });
}

function withHeaders(res: Response, extra: Record<string, string> = {}): Response {
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries({ ...BASE_HEADERS, ...extra })) out.headers.set(k, v);
  return out;
}

/** Routing context: the request origin and the secret path prefix ("/<BASE_PATH>"). */
interface Ctx {
  origin: string;
  root: string;
  /** <html> attributes from the theme cookie (see theme.ts). */
  theme: string;
}

function html(c: Ctx, body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(c.theme ? body.replace("<html>", `<html${c.theme}>`) : body, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": uiCsp(c.origin, c.root), ...headers },
  });
}

function asset(body: string, type: string): Response {
  return new Response(body, { headers: { "content-type": type, "cache-control": "public, max-age=86400" } });
}

function redirect(location: string, headers: Record<string, string> = {}): Response {
  return new Response(null, { status: 303, headers: { location, ...headers } });
}

/** ASCII only, so the index range in whereClause is exact; long enough to stay selective. */
const TO_PREFIX_RE = /^[a-z0-9._+@-]{3,254}$/;
const TO_DOMAIN_RE = /^[a-z0-9.-]{1,253}$/;

function listQuery(p: URLSearchParams, defaults: { limit: number; order: "asc" | "desc" }): ListQuery | string {
  const since = p.get("since");
  const before = p.get("before");
  const sinceMs = parseTime(since);
  const beforeMs = parseTime(before);
  if (since && sinceMs === null) return "bad since";
  if (before && beforeMs === null) return "bad before";
  const cursorParam = p.get("cursor");
  const cursor = parseCursor(cursorParam);
  if (cursorParam && !cursor) return "bad cursor";
  const order = p.get("order");
  const to = p.get("to")?.trim() || undefined;
  const toPrefix = p.get("to_prefix")?.trim().toLowerCase() || undefined;
  if (toPrefix && !TO_PREFIX_RE.test(toPrefix)) return "to_prefix wants 3-254 characters: letters, digits and . _ + - @";
  if (to && toPrefix) return "use to or to_prefix, not both";
  const toDomain = p.get("to_domain")?.trim().toLowerCase() || undefined;
  if (toDomain && !TO_DOMAIN_RE.test(toDomain)) return "to_domain wants a domain name";
  const newsletters = p.get("newsletters") || undefined;
  if (newsletters && newsletters !== "hide" && newsletters !== "only") return "newsletters is hide or only";
  return {
    to,
    toPrefix,
    toDomain,
    newsletters: newsletters as "hide" | "only" | undefined,
    subject: p.get("subject") || undefined,
    q: p.get("q") || undefined,
    fromDomain: p.get("from_domain")?.trim() || undefined,
    since: sinceMs ?? undefined,
    before: beforeMs ?? undefined,
    cursor: cursor ?? undefined,
    limit: intVar(p.get("limit") ?? undefined, defaults.limit, 1, 200),
    withText: p.get("text") !== "0",
    order: order === "asc" || order === "desc" ? order : defaults.order,
  };
}

function rawResponse(raw: Uint8Array, id: string): Response {
  return new Response(raw, {
    headers: {
      "content-type": "message/rfc822",
      "content-disposition": `attachment; filename="${id}.eml"`,
      "cache-control": "no-store",
    },
  });
}

/** View links are bearer credentials that end up in browser history and logs: keep them short. */
const MAX_VIEW_TTL = 3600;

async function viewToken(env: Env, id: string, images: boolean, ttlSeconds?: number) {
  const ttl = Math.min(ttlSeconds ?? intVar(env.VIEW_LINK_TTL, 900, 30, MAX_VIEW_TTL), MAX_VIEW_TTL);
  const exp = Math.floor(Date.now() / 1000) + ttl;
  const sig = await signView(env, id, exp, images);
  return { exp, token: `${exp}.${images ? 1 : 0}.${sig}` };
}

async function viewLink(env: Env, c: Ctx, id: string, images: boolean, ttlSeconds?: number) {
  const { exp, token } = await viewToken(env, id, images, ttlSeconds);
  return {
    url: `${c.origin}${c.root}/view/${id}?t=${token}`,
    body_url: `${c.origin}${c.root}/view/${id}/body?t=${token}`,
    expires_at: new Date(exp * 1000).toISOString(),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Most pending messages a single read request will parse. On the edge one parse of a typical
 * message is 2-10 ms of CPU, so one per request keeps reads near the free plan's 10 ms.
 */
const READ_PARSE_MAX = 1;

/**
 * List reads only parse pending messages up to this size; bigger ones are left to the cron (or
 * to a read of that message by id). A list request is not about any one message, so a hostile
 * message should never be able to make one fail.
 */
const LIST_PARSE_MAX_BYTES = 48 * 1024;

/**
 * Parse any `pending` rows in a result before returning it. Bounded by count and bytes so one
 * request stays within the free plan's CPU limit; anything left stays `pending` for the cron.
 *
 * A per-address read (`to` or `to_prefix` set) is a read of that mailbox, so it parses unparsed rows of any size,
 * pending or deferred, newest first, up to TO_READ_PARSE_MAX of them (default 1 for the free
 * plan; raise it on Paid so a mailbox listing never shows an empty body).
 */
async function freshen(env: Env, rows: MessageOut[], perAddress: boolean): Promise<boolean> {
  if (perAddress) {
    const max = intVar(env.TO_READ_PARSE_MAX, 1, 0, 100);
    const todo = rows
      .filter((m) => m.parse_status === "pending" || m.parse_status === "deferred")
      .sort((a, b) => b.received_at.localeCompare(a.received_at))
      .slice(0, max);
    let parsed = 0;
    for (const m of todo) if (await parseMessage(env, m.id, { firstAttemptOnly: true })) parsed++;
    return parsed > 0;
  }
  const budget = intVar(env.PARSE_BYTES, DEFAULT_PARSE_BYTES, 16 * 1024);
  let spent = 0;
  let parsed = 0;
  for (const m of rows) {
    if (m.parse_status !== "pending" || parsed >= READ_PARSE_MAX || m.raw_size > LIST_PARSE_MAX_BYTES) continue;
    const cost = Math.min(m.raw_size, budget);
    if (parsed > 0 && spent + cost > budget) break;
    if (await parseMessage(env, m.id, { firstAttemptOnly: true })) parsed++;
    spent += cost;
  }
  return parsed > 0;
}

async function listFresh(env: Env, q: ListQuery): Promise<MessageOut[]> {
  const rows = await listMessages(env.DB, q);
  return (await freshen(env, rows, Boolean(q.to || q.toPrefix))) ? listMessages(env.DB, q) : rows;
}

/** A read of one message parses it if it is pending or deferred (big mail, parsed on demand). */
const needsParse = (m: MessageOut | null | undefined) => m?.parse_status === "pending" || m?.parse_status === "deferred";

async function getFresh(env: Env, id: string) {
  const m = await getMessage(env.DB, id);
  if (needsParse(m) && (await parseMessage(env, id, { firstAttemptOnly: true }))) return getMessage(env.DB, id);
  return m;
}

/**
 * Cloudflare closes a request that sends nothing for about 60 s, so waits are capped at 50 s.
 * Polls back off (1 s, then 2 s, then 4 s) to keep total CPU inside the free plan's budget:
 * each D1 poll costs roughly 0.4 ms.
 */
export const WAIT_MAX_SECONDS = 50;

async function waitFor(env: Env, q: ListQuery, timeoutSeconds: number, signal: AbortSignal): Promise<MessageOut | null> {
  const start = Date.now();
  const deadline = start + timeoutSeconds * 1000;
  for (;;) {
    const rows = await listMessages(env.DB, { ...q, limit: 1, order: "desc" });
    if (rows[0]) return needsParse(rows[0]) ? ((await getFresh(env, rows[0].id)) ?? rows[0]) : rows[0];
    const elapsed = Date.now() - start;
    const pause = elapsed < 10_000 ? 1000 : elapsed < 30_000 ? 2000 : 4000;
    if (Date.now() + pause > deadline || signal.aborted) return null;
    await sleep(pause);
  }
}

async function api(req: Request, env: Env, url: URL, parts: string[], c: Ctx): Promise<Response> {
  if (!(await hasApiKey(req, env))) {
    logAuthFailure(req, url.pathname);
    return errorJson(401, "missing or bad api key");
  }
  const p = url.searchParams;

  // /api/emails
  if (parts.length === 2 && parts[1] === "emails" && req.method === "GET") {
    const q = listQuery(p, { limit: 20, order: "desc" });
    if (typeof q === "string") return errorJson(400, q);
    const emails = await listFresh(env, q);
    if (q.to || q.toPrefix) await markRead(env.DB, emails.map((m) => m.id));
    // Pass next_cursor back as `cursor` for the next (older) page; null means no more.
    return json({ emails, next_cursor: nextCursor(emails, q.limit) });
  }

  // /api/wait
  if (parts.length === 2 && parts[1] === "wait" && req.method === "GET") {
    const q = listQuery(p, { limit: 1, order: "desc" });
    if (typeof q === "string") return errorJson(400, q);
    if (!q.to && !q.toPrefix && !q.toDomain && !q.subject && !q.q) return errorJson(400, "wait needs to, to_prefix, to_domain, subject or q");
    q.newsletters = undefined; // a wait never hides anything
    q.since ??= Date.now();
    const found = await waitFor(env, q, intVar(p.get("timeout") ?? undefined, 30, 1, WAIT_MAX_SECONDS), req.signal);
    if (!found) return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    const { compressed: _c, chunk_count: _n, ...out } = found as MessageOut & { compressed?: boolean; chunk_count?: number };
    await markRead(env.DB, [found.id]);
    // More than one match since `since` means someone else may have mailed this address too.
    return json({ ...out, match_count: await countMessages(env.DB, q) });
  }

  // /api/stats: running counters only, so polling it stays cheap.
  if (parts.length === 2 && parts[1] === "stats" && req.method === "GET") {
    // ?days=N adds the daily series (daily_stats keeps DAILY_STATS_KEEP_DAYS of them).
    const daysParam = p.get("days");
    const days = daysParam === null ? 0 : /^\d{1,3}$/.test(daysParam) ? Number(daysParam) : -1;
    if (daysParam !== null && (days < 1 || days > DAILY_STATS_KEEP_DAYS)) return errorJson(400, `days wants 1-${DAILY_STATS_KEEP_DAYS}`);
    const [o, series, domains, perDomain] = await Promise.all([
      overview(env.DB),
      dailyCounts(env.DB, Math.max(days, 1)),
      domainCounts(env.DB, 30),
      days ? domainDays(env.DB, days) : Promise.resolve(null),
    ]);
    const today = series.at(-1)!;
    const iso = (t: number | null | undefined) => (t ? new Date(t).toISOString() : null);
    return json({
      version: VERSION,
      messages: o.messages,
      today: today.received,
      stored_bytes: o.storedBytes,
      max_store_bytes: intVar(env.MAX_STORE_MB, DEFAULT_MAX_STORE_MB, 1) * 1024 * 1024,
      retention_days: intVar(env.RETENTION_DAYS, 30, 0),
      oldest: iso(o.oldest),
      newest: iso(o.newest),
      parse_pending: o.pending,
      // Big mail not parsed yet: parsed when read, or in the background with CRON_PARSE_DEFERRED.
      parse_deferred: o.deferred,
      // Newsletters stored now (hidden by newsletters=hide), and mail rejected by blocks, ever.
      newsletters: o.newsletters,
      blocked: o.blocked,
      parse_failed: o.failed,
      // Mail that arrived but could not be stored. Non-zero means mail was lost.
      store_failures: o.storeFailures,
      last_store_failure: iso(o.lastStoreFailure),
      // Mail per recipient domain over the last 30 UTC days, most first.
      domains,
      domains_set_up: listVar(env.DOMAINS),
      ...(perDomain && {
        days: series.map((d) => ({ day: d.day, received: d.received, raw_bytes: d.rawBytes })),
        domain_days: perDomain,
      }),
    });
  }

  // /api/blocks: senders, addresses and address families whose mail is rejected at arrival.
  if (parts[1] === "blocks") {
    if (parts.length === 2 && req.method === "GET") return json({ blocks: await listBlocks(env.DB) });
    if (parts.length === 2 && req.method === "POST") {
      const b = parseBlock(await req.json().catch(() => null));
      if (typeof b === "string") return errorJson(400, b);
      if ((await countBlocks(env.DB)) >= MAX_BLOCKS) return errorJson(400, `at most ${MAX_BLOCKS} blocks`);
      const { block, created } = await addBlock(env.DB, b);
      return json(block, created ? 201 : 200);
    }
    if (parts.length === 3 && req.method === "DELETE") {
      const id = /^\d{1,12}$/.test(parts[2]!) ? Number(parts[2]) : 0;
      return id && (await removeBlock(env.DB, id)) ? json({ ok: true }) : errorJson(404, "not found");
    }
    return errorJson(405, "method not allowed");
  }

  // /api/emails/:id[/raw|/view-link|/attachments/:n]
  if (parts[1] === "emails" && parts[2] && req.method === "GET") {
    const id = parts[2];
    if (!ID_RE.test(id)) return errorJson(404, "not found");
    if (parts.length === 3) {
      const m = await getFresh(env, id);
      if (!m) return errorJson(404, "not found");
      await markRead(env.DB, [id]);
      const { compressed: _c, chunk_count: _n, ...out } = m;
      return json(out);
    }
    if (parts.length === 4 && parts[3] === "raw") {
      const raw = await loadRaw(env.DB, id);
      return raw ? rawResponse(raw, id) : errorJson(404, "not found");
    }
    if (parts.length === 4 && parts[3] === "view-link") {
      if (!(await getMessage(env.DB, id))) return errorJson(404, "not found");
      const ttl = p.get("ttl") ? intVar(p.get("ttl") ?? undefined, 900, 30, MAX_VIEW_TTL) : undefined;
      return json(await viewLink(env, c, id, p.get("images") === "1", ttl));
    }
    if (parts.length === 5 && parts[3] === "attachments") {
      const n = intVar(parts[4], -1, -1);
      const raw = await loadRaw(env.DB, id);
      if (!raw) return errorJson(404, "not found");
      const att = (await parseFull(raw)).attachments[n];
      if (!att) return errorJson(404, "no such attachment");
      const safeName = (att.filename ?? `attachment-${n}`).replace(/[^\w.\- ]+/g, "_");
      return new Response(att.content as ArrayBuffer, {
        headers: {
          "content-type": "application/octet-stream",
          "content-disposition": `attachment; filename="${safeName}"`,
          "cache-control": "no-store",
        },
      });
    }
  }
  return errorJson(404, "not found");
}

/** Most raw bytes one simple-list response carries; rows past it get `raw_truncated: true`. */
const SIMPLE_RAW_BUDGET = 1024 * 1024;

/**
 * `<base>/emails`: a plain array for scripts, newest last (take the last element), with `from`,
 * `to`, `subject`, `body`, `raw` and `timestamp`. `raw` (the full MIME as text) is included for
 * per-mailbox queries (`to` set) or with `raw=1`, newest first, up to SIMPLE_RAW_BUDGET bytes per
 * response; `raw=0` drops it.
 */
async function simpleList(req: Request, env: Env, url: URL): Promise<Response> {
  if (!(await hasApiKey(req, env))) {
    logAuthFailure(req, url.pathname);
    return new Response("Forbidden", { status: 403 });
  }
  const p = url.searchParams;
  const q = listQuery(p, { limit: 50, order: "asc" });
  if (typeof q === "string") return errorJson(400, q);
  const rows = await listFresh(env, { ...q, withText: true });
  const wantRaw = p.get("raw") === "1" || (Boolean(q.to) && p.get("raw") !== "0");
  const rawIds: string[] = [];
  let budget = SIMPLE_RAW_BUDGET;
  for (const m of [...rows].reverse()) {
    if (!wantRaw || m.raw_size > budget) continue;
    rawIds.push(m.id);
    budget -= m.raw_size;
  }
  const raws = rawIds.length ? await loadRawMany(env.DB, rawIds) : new Map<string, Uint8Array>();
  if (q.to || q.toPrefix) await markRead(env.DB, rows.map((m) => m.id));
  const text = new TextDecoder();
  return json(
    rows.map((m) => {
      const raw = raws.get(m.id);
      return {
        id: m.id,
        from: m.from,
        to: m.to,
        subject: m.subject,
        body: m.text ?? "",
        ...(raw ? { raw: text.decode(raw) } : wantRaw ? { raw_truncated: true } : {}),
        timestamp: m.received_at,
        header_to: m.header_to,
        codes: m.codes,
        links: m.links,
        auth: m.auth,
      };
    }),
  );
}

/** Accepts `t=<exp>.<images>.<sig>` or `exp=&images=&sig=`. */
function viewAuth(p: URLSearchParams): { exp: string | null; images: boolean; sig: string | null } {
  const t = p.get("t");
  if (t) {
    const [exp, images, sig] = t.split(".");
    return { exp: exp ?? null, images: images === "1", sig: sig ?? null };
  }
  return { exp: p.get("exp"), images: p.get("images") === "1", sig: p.get("sig") };
}

async function view(req: Request, env: Env, url: URL, parts: string[], c: Ctx): Promise<Response> {
  const id = parts[1] ?? "";
  if (!ID_RE.test(id)) return new Response("Not found", { status: 404 });
  const a = viewAuth(url.searchParams);
  if (!(await verifyView(env, id, a.exp, a.images, a.sig))) {
    logAuthFailure(req, "/view");
    return new Response("Link expired or invalid", { status: 403 });
  }
  const token = `${a.exp}.${a.images ? 1 : 0}.${a.sig}`;

  // Outer page: stored summary only, no MIME parse.
  if (parts.length === 2) {
    const meta = await getMessage(env.DB, id);
    if (!meta) return new Response("Not found", { status: 404 });
    const nonce = toHex(crypto.getRandomValues(new Uint8Array(16)));
    return new Response(renderViewPage(meta, `${c.root}/view/${id}/body?t=${token}`, a.images, nonce), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": outerCsp(url.origin, nonce), "x-dns-prefetch-control": "off" },
    });
  }

  const raw = await loadRaw(env.DB, id);
  if (!raw) return new Response("Not found", { status: 404 });
  const email = await parseFull(raw);

  if (parts.length === 3 && parts[2] === "body") {
    return new Response(renderBodyHtml(email, id, token, c.root, a.images), {
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": bodyCsp(url.origin, a.images), "x-dns-prefetch-control": "off" },
    });
  }
  if (parts.length === 4 && parts[2] === "cid") {
    let cid: string;
    try {
      cid = decodeURIComponent(parts[3]!);
    } catch {
      return new Response("Not found", { status: 404 });
    }
    const att = findCid(email, cid);
    if (!att) return new Response("Not found", { status: 404 });
    const type = /^image\/(png|gif|jpeg|webp|bmp|x-icon|avif)$/.test(att.mimeType) ? att.mimeType : "application/octet-stream";
    return new Response(att.content as ArrayBuffer, { headers: { "content-type": type, "cache-control": "private, max-age=300" } });
  }
  return new Response("Not found", { status: 404 });
}

/** Inbox rows per page. Summaries only (no text), so a page stays small. */
const INBOX_PAGE = 50;

async function ui(req: Request, env: Env, url: URL, parts: string[], c: Ctx): Promise<Response> {
  if (parts[0] === "login") {
    if (req.method === "GET") return html(c, loginPage(c.root));
    if (req.method === "POST") {
      const form = await req.formData().catch(() => null);
      const key = form?.get("key");
      if (typeof key === "string" && keyConfigured(env) && (await safeEqual(key, env.API_KEY))) {
        return redirect(`${c.root}/inbox`, { "set-cookie": await makeSession(env) });
      }
      logAuthFailure(req, "/login");
      return html(c, loginPage(c.root, "Wrong key."), 401);
    }
  }
  if (parts[0] === "logout" && req.method === "POST") return redirect(`${c.root}/login`, { "set-cookie": clearSession() });
  if (!(await hasSession(req, env))) return redirect(`${c.root}/login`);

  // Block forms (message page) and Unblock (stats page). The session cookie is SameSite=Strict, and
  // the Origin header must be ours too.
  if (parts[0] === "blocks" && req.method === "POST") {
    const origin = req.headers.get("origin");
    if (origin && origin !== c.origin) return html(c, "Forbidden", 403);
    if (parts.length === 1) {
      const form = await req.formData().catch(() => null);
      const b = parseBlock({ kind: form?.get("kind"), value: form?.get("value"), scope: form?.get("scope") || undefined });
      if (typeof b === "string") return html(c, e(b), 400);
      if ((await countBlocks(env.DB)) >= MAX_BLOCKS) return html(c, `At most ${MAX_BLOCKS} blocks.`, 400);
      await addBlock(env.DB, b);
      const back = form?.get("back");
      return redirect(typeof back === "string" && back.startsWith(`${c.root}/`) && !back.includes("//", 1) ? back : `${c.root}/stats#blocks`);
    }
    if (parts.length === 3 && parts[2] === "delete" && /^\d{1,12}$/.test(parts[1]!)) {
      await removeBlock(env.DB, Number(parts[1]));
      return redirect(`${c.root}/stats#blocks`);
    }
    return html(c, "Not found", 404);
  }

  if (parts[0] === "stats" && parts.length === 1) {
    const [o, days, top, domains, blocks] = await Promise.all([
      overview(env.DB),
      dailyCounts(env.DB, 30),
      recentTop(env.DB),
      domainCounts(env.DB, 30),
      listBlocks(env.DB),
    ]);
    return html(c, statsPage(c.root, {
      overview: o,
      days,
      top,
      domains,
      blocks,
      setUp: listVar(env.DOMAINS),
      maxStoreBytes: intVar(env.MAX_STORE_MB, DEFAULT_MAX_STORE_MB, 1) * 1024 * 1024,
      retentionDays: intVar(env.RETENTION_DAYS, 30, 0),
    }));
  }

  if (parts.length === 1) {
    const p = url.searchParams;
    const before = parseTime(p.get("before"));
    const cursor = parseCursor(p.get("cursor"));
    const to = p.get("to")?.trim() || undefined;
    // Newsletters are hidden unless asked for; a list for one address shows everything.
    const nl = to ? "all" : p.get("newsletters") === "show" ? "shown" : "hidden";
    const rows = await listFresh(env, {
      to,
      newsletters: nl === "hidden" ? "hide" : undefined,
      q: p.get("q") || undefined,
      before: before ?? undefined,
      cursor: cursor ?? undefined,
      limit: INBOX_PAGE,
      withText: false,
      order: "desc",
    });
    const hiddenCount = nl === "hidden" ? await newsletterCount(env.DB) : 0;
    return html(
      c,
      inboxPage(c.root, rows, { to: p.get("to") ?? "", q: p.get("q") ?? "", paged: Boolean(cursor || before), next: nextCursor(rows, INBOX_PAGE), newsletters: nl, hiddenCount }),
    );
  }
  const id = parts[1]!;
  if (!ID_RE.test(id)) return html(c, "Not found", 404);
  if (parts.length === 2) {
    const m = await getFresh(env, id);
    if (!m) return html(c, "Not found", 404);
    await markRead(env.DB, [id]);
    const plain = await viewLink(env, c, id, false);
    const withImages = await viewLink(env, c, id, true);
    return html(c, messagePage(c.root, m, plain.url, withImages.url, plain.body_url));
  }
  if (parts.length === 3 && parts[2] === "raw") {
    const raw = await loadRaw(env.DB, id);
    return raw ? rawResponse(raw, id) : html(c, "Not found", 404);
  }
  return html(c, "Not found", 404);
}

/**
 * Each cron run parses up to CRON_PARSE_MAX pending messages, oldest first, stopping once about
 * CRON_PARSE_BYTES of raw mail has been handled (a single bigger message still gets its turn).
 * Only mail up to BACKGROUND_PARSE_MAX_BYTES (64 KB) is pending at arrival, so four fit a run:
 * up to 240 messages an hour. Bigger mail is deferred and parsed when read. A run that runs out
 * of CPU loses nothing: the message stays stored and is retried on a smaller slice.
 */
const CRON_PARSE_MAX = 4;
const CRON_PARSE_BYTES = 256 * 1024;

export default {
  async fetch(req, env): Promise<Response> {
    const url = new URL(req.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const base = basePath(env);
    if (!base || !segments[0] || !(await safeEqual(segments[0], base))) return notFound();
    const c: Ctx = { origin: url.origin, root: `/${base}`, theme: themeAttrs(req.headers.get("cookie")) };
    const parts = segments.slice(1);
    const route = parts.join("/");
    try {
      if (parts[0] === "api") return withHeaders(await api(req, env, url, parts, c));
      if (parts[0] === "view") return withHeaders(await view(req, env, url, parts, c));
      if (route === "emails" && req.method === "GET") return withHeaders(await simpleList(req, env, url));
      if (parts.length === 0) return redirect(`${c.root}/inbox`);
      if (route === "health") return withHeaders(json({ ok: true, version: VERSION }));
      if (route === "favicon.svg") return withHeaders(asset(FAVICON_SVG, "image/svg+xml"));
      if (route === "ui.js") return withHeaders(asset(UI_JS, "text/javascript; charset=utf-8"));
      if (parts[0] === "inbox" || parts[0] === "stats" || parts[0] === "login" || parts[0] === "logout" || parts[0] === "blocks") {
        return withHeaders(await ui(req, env, url, parts, c), { "x-frame-options": "DENY" });
      }
      return withHeaders(errorJson(404, "not found"));
    } catch (err) {
      console.error(JSON.stringify({ event: "fetch_error", path: route, error: String(err) }));
      return withHeaders(errorJson(500, "internal error"));
    }
  },

  async email(message, env): Promise<void> {
    await handleEmail(message, env);
  },

  /** Every minute: parse the oldest pending messages (see CRON_PARSE_MAX). Once an hour: retention. */
  async scheduled(controller, env): Promise<void> {
    const parsed = await parsePending(env, CRON_PARSE_BYTES, CRON_PARSE_MAX, env.CRON_PARSE_DEFERRED === "1");
    if (parsed) console.log(JSON.stringify({ event: "parsed", count: parsed }));
    if (new Date(controller.scheduledTime).getUTCMinutes() === 17) {
      const result = await enforceRetention(
        env.DB,
        intVar(env.RETENTION_DAYS, 30, 0),
        intVar(env.MAX_STORE_MB, DEFAULT_MAX_STORE_MB, 1) * 1024 * 1024,
        Date.now(),
        intVar(env.NEWSLETTER_RETENTION_DAYS, 0, 0),
      );
      console.log(JSON.stringify({ event: "retention", ...result }));
    }
  },
} satisfies ExportedHandler<Env>;
