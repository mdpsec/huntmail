import { createExecutionContext, createScheduledController, SELF, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { MAX_PARSE_ATTEMPTS, parseMessage, summarizeBody } from "../src/ingest";
import { enforceRetention } from "../src/store";
import { alternative, fakeMessage, htmlOnly, latin1, mixedWithFiles, plain, randomBinary, related } from "./mail";

const KEY = "a7c3e9f1b2d4068e5f7a9c1b3d5e7f9012345678abcdef0123456789abcdef01";
const H = { "x-api-key": KEY };
const ORIGIN = "https://huntmail.test";
const ROOT = "/p7f3a9c2e8b14d6f0a5c";
const BASE = ORIGIN + ROOT;

async function deliver(raw: string | Uint8Array, envelope: { to?: string; from?: string } = {}, e: Env = env) {
  const msg = fakeMessage(raw, envelope);
  const ctx = createExecutionContext();
  await worker.email(msg, e);
  await waitOnExecutionContext(ctx);
  return msg;
}

async function apiJson<T = any>(path: string, init: RequestInit = {}): Promise<{ status: number; body: T; res: Response }> {
  const res = await SELF.fetch(BASE + path, { ...init, headers: { ...H, ...(init.headers ?? {}) } });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null, res };
}

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM raw_chunks"), env.DB.prepare("DELETE FROM messages"), env.DB.prepare("DELETE FROM daily_stats"), env.DB.prepare("DELETE FROM domain_daily")]);
});

describe("ingest", () => {
  it("stores multipart/alternative with QP text and base64 html", async () => {
    await deliver(alternative("Your code is 482913 — thanks", `<p>Click <a href="https://acme.example/v?t=1">verify</a></p>`), { to: "Victim-1@Hunt.Example" });
    const { body } = await apiJson("/api/emails?to=victim-1@hunt.example");
    expect(body.emails).toHaveLength(1);
    const m = body.emails[0];
    expect(m.to).toBe("victim-1@hunt.example");
    expect(m.text).toContain("Your code is 482913 — thanks");
    expect(m.codes[0]).toBe("482913");
    expect(m.links).toEqual(["https://acme.example/v?t=1"]);
    expect(m.has_html).toBe(true);
    expect(m.header_from).toBe("Acme Security <no-reply@acme.example>");
    expect(m.parse_status).toBe("ok");
  });

  it("decodes encoded-word subjects and latin-1 bodies", async () => {
    await deliver(latin1("Bonjour, votre code: 7731. Caf\xe9.", { subject: "=?UTF-8?B?w4dhIHZhIOKckw==?=" }));
    const { body } = await apiJson("/api/emails?to=victim-1@hunt.example");
    expect(body.emails[0].subject).toBe("Ça va ✓");
    expect(body.emails[0].text).toContain("Café");
  });

  it("derives text from html-only mail", async () => {
    await deliver(htmlOnly(`<html><body><h1>Reset</h1><p>Use 55667788 to reset</p></body></html>`));
    const { body } = await apiJson("/api/emails?to=victim-1@hunt.example");
    expect(body.emails[0].text).toContain("Use 55667788 to reset");
    expect(body.emails[0].codes).toContain("55667788");
  });

  it("keeps malformed mail instead of dropping it", async () => {
    await deliver("this is not mime at all");
    const { body } = await apiJson("/api/emails?to=victim-1@hunt.example");
    expect(body.emails).toHaveLength(1);
  });

  it("forwards to FORWARD_TO targets and survives a forward failure", async () => {
    const e = { ...env, FORWARD_TO: "a@x.example, b@x.example" } as Env;
    const msg = fakeMessage(plain("hi"));
    msg.forward.mockRejectedValueOnce(new Error("unverified"));
    await worker.email(msg, e);
    expect(msg.forward).toHaveBeenCalledTimes(2);
    const { body } = await apiJson("/api/emails?to=victim-1@hunt.example");
    expect(body.emails).toHaveLength(1);
  });

  it("does not throw when the store fails", async () => {
    const broken = { ...env, DB: { prepare: () => { throw new Error("d1 down"); } } } as unknown as Env;
    await expect(worker.email(fakeMessage(plain("x")), broken)).resolves.toBeUndefined();
  });

  it("parses only the head of big mail but keeps every raw byte", async () => {
    const raw = related(`<p>Code 246810 <img src="cid:logo@acme"></p>`, { attachmentBytes: 2_500_000 });
    expect(raw.length).toBeGreaterThan(131072);
    await deliver(raw);
    const { body } = await apiJson("/api/emails?to=victim-1@hunt.example");
    // Big mail is deferred (never parsed in the background); a per-address read parses it.
    expect(body.emails[0].parse_status).toBe("partial");
    const m = (await apiJson(`/api/emails/${body.emails[0].id}`)).body;
    expect(m.parse_status).toBe("partial");
    expect(m.codes).toContain("246810");
    const res = await SELF.fetch(`${BASE}/api/emails/${m.id}/raw`, { headers: H });
    expect(res.headers.get("content-type")).toBe("message/rfc822");
    expect(await res.text()).toBe(raw);
    const row = await env.DB.prepare("SELECT compressed, chunk_count FROM messages WHERE id = ?").bind(m.id).first<any>();
    expect(row.compressed).toBe(0);
    expect(row.chunk_count).toBeGreaterThan(3);
  });

  it("round-trips gzip raw byte for byte", async () => {
    const bin = latin1("caf\xe9 \xff\xfe binary-ish");
    await deliver(bin);
    const { body } = await apiJson("/api/emails?to=victim-1@hunt.example");
    const res = await SELF.fetch(`${BASE}/api/emails/${body.emails[0].id}/raw`, { headers: H });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bin);
  });

  it("summarizeBody never throws on random bytes", async () => {
    const s = await summarizeBody(randomBinary(4096), 256 * 1024);
    expect(["ok", "partial", "failed"]).toContain(s.parseStatus);
  });

  it("stores as pending with header fields only; the first read parses it", async () => {
    await deliver(alternative("Your code is 112233", "<p>x</p>", { subject: "Sign-in code 998877" }));
    const row = await env.DB.prepare("SELECT parse_status, text, subject, codes FROM messages").first<any>();
    expect(row).toMatchObject({ parse_status: "pending", text: "", subject: "Sign-in code 998877" });
    // Codes (subject and body) come from the parse step, not arrival.
    expect(JSON.parse(row.codes)).toEqual([]);
    const m = (await apiJson("/api/emails")).body.emails[0];
    expect(m.parse_status).toBe("ok");
    expect(m.codes).toEqual(expect.arrayContaining(["998877", "112233"]));
  });

  it("a read parses at most one pending message; the rest wait", async () => {
    for (let i = 0; i < 3; i++) await deliver(plain(`m${i}`));
    const rows = (await apiJson("/api/emails?text=0")).body.emails;
    expect(rows.filter((m: any) => m.parse_status === "ok")).toHaveLength(1);
    expect(rows.filter((m: any) => m.parse_status === "pending")).toHaveLength(2);
  });

  it("cron parses up to 4 small pending messages per run, oldest first", async () => {
    for (let i = 0; i < 6; i++) await deliver(plain(`code ${i}0000${i}`), { to: `c${i}@hunt.example` });
    const pending = () => env.DB.prepare("SELECT envelope_to FROM messages WHERE parse_status = 'pending' ORDER BY received_at").all<{ envelope_to: string }>();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 0, 1, 0, 5) }), env);
    expect((await pending()).results.map((r) => r.envelope_to)).toEqual(["c4@hunt.example", "c5@hunt.example"]);
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 0, 1, 0, 6) }), env);
    expect((await pending()).results).toHaveLength(0);
  });

  it("big mail arrives deferred: the cron skips it, a read parses it, and the counter stays exact", async () => {
    await deliver(plain("Your code is 864201\n" + "z".repeat(70_000)), { to: "big@hunt.example" });
    await deliver(plain("small 135790"), { to: "small@hunt.example" });
    const status = async (to: string) =>
      (await env.DB.prepare("SELECT parse_status FROM messages WHERE envelope_to = ?").bind(to).first<{ parse_status: string }>())!.parse_status;
    const exact = async () => {
      const r = await env.DB.prepare(`SELECT (SELECT v FROM meta WHERE k = 'stored_bytes') AS counted, SUM(stored_size) AS rows FROM messages`).first<any>();
      expect(r.counted).toBe(r.rows);
      return r.counted as number;
    };
    expect(await status("big@hunt.example")).toBe("deferred");
    const deferredSize = await exact();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 0, 1, 0, 5) }), env);
    expect(await status("small@hunt.example")).toBe("ok");
    expect(await status("big@hunt.example")).toBe("deferred");
    expect((await apiJson("/api/stats")).body.parse_pending).toBe(0);
    // A wait on the address returns it parsed.
    const w = (await apiJson("/api/wait?to=big@hunt.example&since=0&timeout=1")).body;
    expect(w.parse_status).toBe("ok");
    expect(w.codes).toContain("864201");
    expect(await exact()).toBeGreaterThan(deferredSize); // parsed text now counted
  });

  it("per-address reads parse deferred and pending rows, newest first, up to TO_READ_PARSE_MAX", async () => {
    await deliver(plain("Code 111111\n" + "a".repeat(70_000)), { to: "box@hunt.example" });
    await deliver(plain("Code 222222\n" + "b".repeat(70_000)), { to: "box@hunt.example" });
    await deliver(plain("Code 333333 small"), { to: "box@hunt.example" });
    const statuses = async () =>
      (await env.DB.prepare("SELECT parse_status FROM messages ORDER BY received_at").all<{ parse_status: string }>()).results.map((r) => r.parse_status);
    expect(await statuses()).toEqual(["deferred", "deferred", "pending"]);
    // Default 1 (free plan): the newest unparsed row each read.
    let rows = (await apiJson("/emails?to=box@hunt.example")).body;
    expect(rows.map((r: any) => r.body !== "")).toEqual([false, false, true]);
    rows = (await apiJson("/emails?to=box@hunt.example")).body;
    expect(rows.map((r: any) => r.body !== "")).toEqual([false, true, true]);
    // A search without to= never parses big mail.
    await apiJson("/api/emails?q=box");
    expect((await statuses())[0]).toBe("deferred");
    await apiJson("/api/emails?to=box@hunt.example");
    expect(await statuses()).toEqual(["ok", "ok", "ok"]);
  });

  it("with TO_READ_PARSE_MAX raised, one mailbox read returns every body", async () => {
    for (let i = 0; i < 3; i++) await deliver(plain(`Code 40000${i}\n` + "c".repeat(70_000)), { to: "all@hunt.example" });
    const rows = await env.DB.prepare("SELECT * FROM messages").all();
    expect(rows.results).toHaveLength(3);
    const res = await worker.fetch(new Request(`${BASE}/emails?to=all@hunt.example`, { headers: H }), { ...env, TO_READ_PARSE_MAX: "25" });
    const body = (await res.json()) as any[];
    expect(body.every((r) => r.body.startsWith("Code 40000"))).toBe(true);
    expect(body.map((r) => r.codes[0]).sort()).toEqual(["400000", "400001", "400002"]);
  });

  it("with CRON_PARSE_DEFERRED, the cron also parses big mail, newest first, after small pending mail", async () => {
    await deliver(plain("Code 500001\n" + "d".repeat(70_000)), { to: "old@hunt.example" });
    await deliver(plain("Code 500002\n" + "e".repeat(70_000)), { to: "new@hunt.example" });
    await deliver(plain("small 500003"), { to: "small@hunt.example" });
    const status = async (to: string) =>
      (await env.DB.prepare("SELECT parse_status FROM messages WHERE envelope_to = ?").bind(to).first<{ parse_status: string }>())!.parse_status;
    expect((await apiJson("/api/stats")).body.parse_deferred).toBe(2);
    // Off by default: the cron leaves big mail alone.
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 0, 1, 0, 5) }), env);
    expect([await status("small@hunt.example"), await status("new@hunt.example"), await status("old@hunt.example")]).toEqual(["ok", "deferred", "deferred"]);
    const on = { ...env, CRON_PARSE_DEFERRED: "1" };
    // The 256 KB budget: each 70 KB message counts in full, and the first one always runs.
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 0, 1, 0, 6) }), on);
    expect(await status("new@hunt.example")).toBe("ok");
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 0, 1, 0, 7) }), on);
    expect(await status("old@hunt.example")).toBe("ok");
    const st = (await apiJson("/api/stats")).body;
    expect([st.parse_deferred, st.parse_pending]).toEqual([0, 0]);
    const rows = (await apiJson("/api/emails?text=0")).body.emails;
    expect(rows.map((m: any) => m.codes[0]).sort()).toEqual(["500001", "500002", "500003"]);
    const r = await env.DB.prepare(`SELECT (SELECT v FROM meta WHERE k = 'stored_bytes') AS counted, SUM(stored_size) AS rows FROM messages`).first<any>();
    expect(r.counted).toBe(r.rows);
    const plan = await env.DB.prepare("EXPLAIN QUERY PLAN SELECT id, raw_size FROM messages WHERE parse_status = 'deferred' ORDER BY received_at DESC LIMIT 4").all<{ detail: string }>();
    expect(plan.results.map((p) => p.detail).join(" ")).toMatch(/messages_deferred/);
  });

  it("a deferred read whose parse dies is retried by the cron", async () => {
    await deliver(plain("code 246802 " + "y".repeat(70_000)), { to: "die@hunt.example" });
    const id = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!.id;
    // Simulate a read that claimed it and then ran out of CPU.
    await env.DB.prepare(
      `UPDATE messages SET parse_attempts = 1, parse_status = 'pending', stored_size = stored_size + MIN(raw_size, 100000) + 65536 WHERE id = ?1`,
    ).bind(id).run();
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 0, 1, 0, 5) }), env);
    const m = (await apiJson(`/api/emails/${id}`)).body;
    expect(m.parse_status).toBe("partial"); // the retry reads a 64 KB slice
    expect(m.codes).toContain("246802");
    const r = await env.DB.prepare(`SELECT (SELECT v FROM meta WHERE k = 'stored_bytes') AS counted, SUM(stored_size) AS rows FROM messages`).first<any>();
    expect(r.counted).toBe(r.rows);
  });

  it("migration 0006 defers big queued mail and releases its reserve", async () => {
    await deliver(plain("q".repeat(70_000)), { to: "old@hunt.example" });
    const id = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!.id;
    const deferred = (await env.DB.prepare("SELECT stored_size FROM messages").first<{ stored_size: number }>())!.stored_size;
    // Simulate a row queued before migration 0006: pending, holding the reserve.
    await env.DB.prepare(`UPDATE messages SET parse_status = 'pending', stored_size = stored_size + MIN(raw_size, 100000) + 65536`).run();
    const sql = (env.TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((m) => m.name.startsWith("0006"))!.queries;
    for (const q of sql) await env.DB.prepare(q).run();
    const row = await env.DB.prepare("SELECT parse_status, stored_size FROM messages WHERE id = ?").bind(id).first<any>();
    expect(row).toEqual({ parse_status: "deferred", stored_size: deferred });
    expect((await apiJson("/api/stats")).body.stored_bytes).toBe(deferred);
  });

  it("parsing replaces arrival headers with decoded ones and keeps the size counter exact", async () => {
    const enc = "=?UTF-8?B?" + btoa(String.fromCharCode(...new TextEncoder().encode("認証コード 445566"))) + "?=";
    await deliver(plain("hello", { from: '"Acme Security" <no-reply@acme.example>', subject: enc }), { to: "dec@hunt.example" });
    const before = await env.DB.prepare("SELECT header_from, subject FROM messages").first<any>();
    expect(before.header_from).toBe("Acme Security <no-reply@acme.example>"); // quotes dropped cheaply
    expect(before.subject).toBe("認証コード 445566"); // encoded words still decoded on arrival
    const id = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!.id;
    await parseMessage(env, id);
    const m = (await apiJson(`/api/emails/${id}`)).body;
    expect(m.subject).toBe("認証コード 445566");
    expect(m.header_from).toBe("Acme Security <no-reply@acme.example>");
    expect(m.codes).toContain("445566");
    const r = await env.DB.prepare(
      `SELECT (SELECT v FROM meta WHERE k = 'stored_bytes') AS counted, SUM(stored_size) AS rows FROM messages`,
    ).first<{ counted: number; rows: number }>();
    expect(r!.counted).toBe(r!.rows);
  });

  it("a message whose parse keeps dying ends failed, with raw kept", async () => {
    await deliver(plain("x"));
    const id = (await env.DB.prepare("SELECT id FROM messages").first<{ id: string }>())!.id;
    // Simulate attempts that ran out of CPU: claimed but never completed.
    await env.DB.prepare("UPDATE messages SET parse_attempts = ?1").bind(MAX_PARSE_ATTEMPTS).run();
    expect(await parseMessage(env, id)).toBe(true);
    const m = (await apiJson(`/api/emails/${id}`)).body;
    expect(m.parse_status).toBe("failed");
    expect((await SELF.fetch(`${BASE}/api/emails/${id}/raw`, { headers: H })).status).toBe(200);
    expect(await parseMessage(env, id)).toBe(false);
  });
});

describe("api", () => {
  it("to_prefix lists a family of addresses, case-insensitive, as a mailbox read", async () => {
    await deliver(plain("a 111111"), { to: "acme-1731942000-k7q2x@hunt.example" });
    await deliver(plain("b 222222"), { to: "ACME-1731942001-m3p9z@hunt.example" });
    await deliver(plain("c 333333"), { to: "acmeish@hunt.example" });
    await deliver(plain("d 444444"), { to: "globex-1@hunt.example" });
    const got = (await apiJson("/api/emails?to_prefix=Acme-&text=0")).body.emails.map((m: any) => m.to);
    expect(got.sort()).toEqual(["acme-1731942000-k7q2x@hunt.example", "acme-1731942001-m3p9z@hunt.example"]);
    expect((await apiJson("/api/emails?to_prefix=acme")).body.emails).toHaveLength(3);
    expect((await apiJson("/emails?to_prefix=globex-")).body.map((m: any) => m.to)).toEqual(["globex-1@hunt.example"]);
    // Like `to`, a mailbox read: what it returned is marked read; the other family is not.
    const read = await env.DB.prepare("SELECT envelope_to FROM messages WHERE read_at IS NOT NULL").all<{ envelope_to: string }>();
    expect(read.results.map((r) => r.envelope_to).sort()).toEqual(["acme-1731942000-k7q2x@hunt.example", "acme-1731942001-m3p9z@hunt.example", "acmeish@hunt.example", "globex-1@hunt.example"]);
    const w = (await apiJson("/api/wait?to_prefix=globex-&since=0&timeout=1")).body;
    expect(w.to).toBe("globex-1@hunt.example");
  });

  it("to_prefix is validated and uses the recipient index", async () => {
    expect((await apiJson("/api/emails?to_prefix=ab")).status).toBe(400);
    expect((await apiJson("/api/emails?to_prefix=a%25b%25")).status).toBe(400);
    expect((await apiJson("/api/emails?to_prefix=acme-&to=acme-1@hunt.example")).status).toBe(400);
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE envelope_to >= ? AND envelope_to < ? ORDER BY received_at DESC LIMIT 20",
    ).bind("acme-", "acme.").all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toMatch(/messages_to_time/);
  });

  it("to_domain lists mail for one recipient domain, exactly, from an index, without marking it read", async () => {
    await deliver(plain("a"), { to: "x@one.example" });
    await deliver(plain("b"), { to: "y@One.example" });
    await deliver(plain("c"), { to: "z@sub.one.example" });
    await deliver(plain("d"), { to: "w@one.example.net" });
    const to = async (qs: string) => (await apiJson(`/api/emails?${qs}`)).body.emails.map((m: any) => m.to).sort();
    expect(await to("to_domain=ONE.example")).toEqual(["x@one.example", "y@one.example"]);
    expect(await to("to_domain=sub.one.example")).toEqual(["z@sub.one.example"]);
    expect(await to("to_domain=one.example&to_prefix=x@o")).toEqual(["x@one.example"]);
    expect(await to("to_domain=one.example&to=x@one.example")).toEqual(["x@one.example"]);
    expect((await apiJson("/emails?to_domain=one.example")).body.map((m: any) => m.to).sort()).toEqual(["x@one.example", "y@one.example"]);
    const w = await apiJson("/api/wait?to_domain=sub.one.example&since=0&timeout=1");
    expect(w.body.to).toBe("z@sub.one.example");
    for (const bad of ["a%20b", "one.example%25", "x@one.example", "a".repeat(254)]) expect((await apiJson(`/api/emails?to_domain=${bad}`)).status).toBe(400);
    const read = await env.DB.prepare("SELECT envelope_to FROM messages WHERE read_at IS NOT NULL").all<{ envelope_to: string }>();
    // Only the to= list and the wait marked mail read; to_domain lists did not.
    expect(read.results.map((r) => r.envelope_to).sort()).toEqual(["x@one.example", "z@sub.one.example"]);
    const plan = await env.DB.prepare(
      "EXPLAIN QUERY PLAN SELECT id FROM messages WHERE substr(envelope_to, instr(envelope_to, '@') + 1) = ? ORDER BY received_at DESC LIMIT 20",
    ).bind("one.example").all<{ detail: string }>();
    expect(plan.results.map((r) => r.detail).join(" ")).toMatch(/messages_to_domain_time/);
  });

  it("requires the api key", async () => {
    expect((await SELF.fetch(`${BASE}/api/emails`)).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/emails`, { headers: { "x-api-key": "wrong" } })).status).toBe(401);
    expect((await SELF.fetch(`${BASE}/api/emails`, { headers: { authorization: `Bearer ${KEY}` } })).status).toBe(200);
    expect((await SELF.fetch(`${BASE}/emails`)).status).toBe(403);
  });

  it("matches `to` exactly, not as a substring", async () => {
    await deliver(plain("a"), { to: "bob@hunt.example" });
    await deliver(plain("b"), { to: "xbob@hunt.example" });
    const { body } = await apiJson("/api/emails?to=bob@hunt.example");
    expect(body.emails.map((m: any) => m.to)).toEqual(["bob@hunt.example"]);
  });

  it("filters by subject, q and since; newest first; the simple list is newest last", async () => {
    await deliver(plain("1", { subject: "Reset your password" }), { to: "f@hunt.example" });
    const mid = Date.now();
    await new Promise((r) => setTimeout(r, 5));
    await deliver(plain("2", { subject: "Welcome aboard", from: "Team <team@other.example>" }), { to: "f@hunt.example" });
    expect((await apiJson("/api/emails?to=f@hunt.example&subject=RESET")).body.emails).toHaveLength(1);
    expect((await apiJson("/api/emails?q=other.example")).body.emails).toHaveLength(1);
    expect((await apiJson(`/api/emails?to=f@hunt.example&since=${mid}`)).body.emails[0].subject).toBe("Welcome aboard");
    const all = (await apiJson("/api/emails?to=f@hunt.example")).body.emails;
    expect(all[0].subject).toBe("Welcome aboard");
    const simple = (await apiJson("/emails?to=f@hunt.example")).body;
    expect(simple.at(-1).subject).toBe("Welcome aboard");
    expect(Object.keys(simple[0])).toEqual(expect.arrayContaining(["from", "to", "subject", "body", "timestamp"]));
    expect((await apiJson("/api/emails?to=f@hunt.example&text=0")).body.emails[0].text).toBeUndefined();
  });

  it("the simple /emails list carries raw for per-mailbox queries", async () => {
    const raw = alternative("code 123456", "<p>x</p>", { subject: "=?UTF-8?B?w4dhIHZh?=" });
    await deliver(raw, { to: "simple@hunt.example" });
    await deliver(plain("other"), { to: "other@hunt.example" });
    const one = (await apiJson("/emails?to=simple@hunt.example")).body;
    expect(one).toHaveLength(1);
    expect(one[0].raw).toBe(raw);
    expect(one[0].subject).toBe("Ça va");
    expect(one[0].body).toContain("code 123456");
    expect((await apiJson("/emails?to=simple@hunt.example&raw=0")).body[0].raw).toBeUndefined();
    const all = (await apiJson("/emails")).body;
    expect(all).toHaveLength(2);
    expect(all[0].raw).toBeUndefined();
    expect((await apiJson("/emails?raw=1")).body.every((m: any) => typeof m.raw === "string")).toBe(true);
    expect((await apiJson("/archive/emails?to=simple@hunt.example")).status).toBe(404); // no alias
  });

  it("escapes LIKE wildcards", async () => {
    await deliver(plain("x", { subject: "100% off" }));
    await deliver(plain("x", { subject: "100 off" }));
    expect((await apiJson("/api/emails?subject=100%25")).body.emails).toHaveLength(1);
  });

  it("wait returns new mail as it arrives, or 204 on timeout", async () => {
    const waiting = apiJson("/api/wait?to=w@hunt.example&timeout=10");
    await new Promise((r) => setTimeout(r, 300));
    await deliver(plain("code 135790"), { to: "w@hunt.example" });
    const { status, body } = await waiting;
    expect(status).toBe(200);
    expect(body.codes).toContain("135790");
    const none = await SELF.fetch(`${BASE}/api/wait?to=nobody@hunt.example&timeout=1`, { headers: H });
    expect(none.status).toBe(204);
    expect((await apiJson("/api/wait")).status).toBe(400);
  });

  it("wait with since returns mail that already arrived", async () => {
    const t = Date.now() - 1000;
    await deliver(plain("early"), { to: "early@hunt.example" });
    const { status } = await apiJson(`/api/wait?to=early@hunt.example&since=${t}&timeout=1`);
    expect(status).toBe(200);
  });

  it("gets one message, 404s unknown ids, reports stats", async () => {
    await deliver(plain("hello"));
    const id = (await apiJson("/api/emails")).body.emails[0].id;
    const one = await apiJson(`/api/emails/${id}`);
    expect(one.body.text).toBe("hello");
    expect(one.body.compressed).toBeUndefined();
    expect((await apiJson(`/api/emails/${"0".repeat(28)}`)).status).toBe(404);
    expect((await apiJson(`/api/emails/../../etc`)).status).toBe(404);
    const stats = (await apiJson("/api/stats")).body;
    expect(stats.messages).toBe(1);
    expect(stats.stored_bytes).toBeGreaterThan(0);
  });

  it("serves attachments by index as downloads", async () => {
    await deliver(related(`<p>x</p>`, { attachmentBytes: 1000 }));
    const id = (await apiJson("/api/emails")).body.emails[0].id;
    const m = (await apiJson(`/api/emails/${id}`)).body;
    const pdf = m.attachments.findIndex((a: any) => a.filename === "report.pdf");
    const res = await SELF.fetch(`${BASE}/api/emails/${id}/attachments/${pdf}`, { headers: H });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/octet-stream");
    expect((await res.arrayBuffer()).byteLength).toBe(1000);
  });
});

describe("view", () => {
  async function linkFor(raw: string, images = false, envelope: { to?: string } = {}) {
    await deliver(raw, envelope);
    const id = (await apiJson("/api/emails?limit=1")).body.emails[0].id;
    const link = (await apiJson(`/api/emails/${id}/view-link${images ? "?images=1" : ""}`)).body;
    return { id, url: new URL(link.url), body: new URL(link.body_url) };
  }
  const tokenParts = (u: URL) => u.searchParams.get("t")!.split(".");

  it("outer page: our banner from the stored summary, mail in a frame, nonce script only", async () => {
    const { url, id } = await linkFor(related(`<html><body><p>Hi <img src="cid:logo@acme"></p></body></html>`));
    const res = await SELF.fetch(url.toString());
    expect(res.status).toBe(200);
    const csp = res.headers.get("content-security-policy")!;
    expect(csp).toMatch(/script-src 'nonce-[0-9a-f]{32}'/);
    expect(csp).toContain("default-src 'none'");
    const page = await res.text();
    expect(page).toContain("Acme Security &#60;no-reply@acme.example&#62;");
    expect(page).toContain(`<iframe id="m" src="${ROOT}/view/${id}/body?t=`);
    expect(page).toContain('sandbox="allow-same-origin"');
    expect(page).not.toContain("Hi <img");
  });

  it("body: sandboxed, no banner, scripts left inert, meta refresh dropped, cid rewritten", async () => {
    const { body } = await linkFor(related(`<html><head><meta http-equiv="refresh" content="0;url=https://evil.example"><meta charset="utf-8"></head><body><script>alert(1)</script><p>Hi <img src="cid:logo@acme"></p></body></html>`));
    const res = await SELF.fetch(body.toString());
    const csp = res.headers.get("content-security-policy")!;
    expect(csp.startsWith("sandbox allow-same-origin;")).toBe(true);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toMatch(/\shttps?:(\s|;|$)/);
    const page = await res.text();
    expect(page).not.toMatch(/http-equiv="refresh"/i);
    expect(page).toContain('<meta charset="utf-8">');
    expect(page).not.toContain("Acme Security");
    const cid = page.match(/src="(\/p7f3a9c2e8b14d6f0a5c\/view\/[^"]+\/cid\/[^"]+)"/)![1]!;
    expect(cid).toMatch(/\?t=\d+\.0\.[0-9a-f]{64}$/);
    const img = await SELF.fetch(ORIGIN + cid);
    expect(img.status).toBe(200);
    expect(img.headers.get("content-type")).toBe("image/png");
  });

  it("decoy <body> tags and hostile CSS cannot reach the banner", async () => {
    const { url } = await linkFor(htmlOnly(`<html><head><title><body></title><style>div{display:none!important}</style></head><body><div>From PayPal</div></body></html>`));
    const page = await (await SELF.fetch(url.toString())).text();
    expect(page).not.toContain("PayPal");
    expect(page).toContain('<div class="hm">');
  });

  it("remote content only with a link signed for images=1, https only", async () => {
    const { body } = await linkFor(htmlOnly(`<img src="https://tracker.example/p.gif">`), true);
    const csp = (await SELF.fetch(body.toString())).headers.get("content-security-policy")!;
    expect(csp).toContain("img-src data: https://huntmail.test https:;");
    expect(csp).not.toContain("http:");
    const [exp, , sig] = tokenParts(body);
    const flipped = new URL(body);
    flipped.searchParams.set("t", `${exp}.0.${sig}`);
    expect((await SELF.fetch(flipped.toString())).status).toBe(403);
  });

  it("an images=0 link cannot be upgraded to load remote content", async () => {
    const { body } = await linkFor(htmlOnly(`<p>x</p>`));
    const [exp, , sig] = tokenParts(body);
    const up = new URL(body);
    up.searchParams.set("t", `${exp}.1.${sig}`);
    expect((await SELF.fetch(up.toString())).status).toBe(403);
    const legacyForm = new URL(body.toString().split("?")[0]! + `?exp=${exp}&images=1&sig=${sig}`);
    expect((await SELF.fetch(legacyForm.toString())).status).toBe(403);
  });

  it("renders plain text escaped", async () => {
    const { body } = await linkFor(plain("<b>not html</b>"));
    const page = await (await SELF.fetch(body.toString())).text();
    expect(page).toContain("&#60;b&#62;not html&#60;/b&#62;");
  });

  it("rejects tampered, foreign, expired and padded links; caps ttl", async () => {
    const { url, id } = await linkFor(plain("x"));
    const [exp, img, sig] = tokenParts(url);
    const at = (t: string, path = `/view/${id}`) => SELF.fetch(`${BASE}${path}?t=${t}`).then((r) => r.status);
    expect(await at(`${exp}.${img}.${"0".repeat(64)}`)).toBe(403);
    expect(await at(`${Number(exp) + 1}.${img}.${sig}`)).toBe(403);
    expect(await at(`0${exp}.${img}.${sig}`)).toBe(403);
    expect(await at(`${exp}.${img}.${sig}`, `/view/${"a".repeat(28)}`)).toBe(403);
    expect(await at(`1.${img}.${sig}`)).toBe(403);
    expect(await at(`${exp}.${img}.${sig}`)).toBe(200);
    const long = (await apiJson(`/api/emails/${id}/view-link?ttl=86400`)).body;
    expect(Date.parse(long.expires_at) - Date.now()).toBeLessThanOrEqual(3600_000 + 5000);
    expect((await SELF.fetch(`${BASE}/view/${id}/cid/%E0%A4%A?t=${exp}.${img}.${sig}`)).status).toBe(404);
  });
});

describe("sender verdicts", () => {
  const AR = (s: string) => `Authentication-Results: ${s}`;
  const signed = (domain: string, extra: string[] = []) =>
    plain("Your code is 424242", {
      from: `Acme <no-reply@${domain}>`,
      extraHeaders: [
        AR(`mx.cloudflare.net; dkim=pass header.d=${domain} header.s=s1 header.b=abc; dmarc=pass (p=REJECT) header.from=${domain}; spf=pass (mx.cloudflare.net: domain of bounce@mail.${domain} designates 1.2.3.4) smtp.mailfrom=bounce@mail.${domain}`),
        "X-CF-SpamH-Score: 3",
        `DKIM-Signature: v=1; a=rsa-sha256; d=${domain}; s=s1; b=abc`,
        ...extra,
      ],
    });

  it("exposes Cloudflare's verdicts and filters by verified sender domain", async () => {
    await deliver(signed("acme.example"), { to: "v@hunt.example" });
    await deliver(plain("Your code is 999999", { from: "Acme <no-reply@acme.example>" }), { to: "v@hunt.example" });
    const ids = (await apiJson("/api/emails?to=v@hunt.example&text=0")).body.emails.map((m: any) => m.id);
    expect(ids).toHaveLength(2);
    const all = await Promise.all(ids.map(async (id: string) => (await apiJson(`/api/emails/${id}`)).body));
    const good = all.find((m: any) => m.codes.includes("424242"));
    expect(good.auth).toEqual({ spf: "pass", dkim: "pass", dmarc: "pass", verified_domains: ["acme.example"], spam_score: 3 });
    expect(all.find((m: any) => m.codes.includes("999999")).auth.verified_domains).toEqual([]);
    const only = (await apiJson("/api/emails?to=v@hunt.example&from_domain=acme.example")).body.emails;
    expect(only.map((m: any) => m.codes[0])).toEqual(["424242"]);
    expect((await apiJson("/api/emails?to=v@hunt.example&from_domain=example")).body.emails).toHaveLength(1);
    expect((await apiJson("/api/emails?to=v@hunt.example&from_domain=cme.example")).body.emails).toHaveLength(0);
  });

  it("ignores Authentication-Results not from Cloudflare or below the first one", async () => {
    await deliver(plain("x", { extraHeaders: [AR("evil.example; dkim=pass header.d=target.example")] }), { to: "a@hunt.example" });
    await deliver(
      plain("x", { extraHeaders: [AR("mx.cloudflare.net; dkim=fail header.d=target.example"), AR("mx.cloudflare.net; dkim=pass header.d=target.example")] }),
      { to: "b@hunt.example" },
    );
    expect((await apiJson("/api/emails?to=a@hunt.example")).body.emails[0].auth.verified_domains).toEqual([]);
    const b = (await apiJson("/api/emails?to=b@hunt.example")).body.emails[0].auth;
    expect(b.dkim).toBe("fail");
    expect(b.verified_domains).toEqual([]);
    expect((await apiJson("/api/emails?from_domain=target.example")).body.emails).toHaveLength(0);
  });

  it("fails closed when the sender could have shaped Cloudflare's header", async () => {
    const sig = "DKIM-Signature: v=1; d=target.example; s=s; b=x";
    // Quoted envelope sender echoed into smtp.mailfrom, injecting a fake dkim=pass.
    const injected = `mx.cloudflare.net; spf=pass (mx.cloudflare.net: domain of "x;dkim=pass header.d=target.example y"@evil.example designates 1.2.3.4) smtp.mailfrom="x;dkim=pass header.d=target.example y"@evil.example`;
    await deliver(plain("code 666666", { extraHeaders: [AR(injected), sig] }), { to: "q1@hunt.example", from: '"x;dkim=pass header.d=target.example y"@evil.example' });
    // Same header but a plain envelope: quoted text is opaque, so nothing is injected.
    await deliver(plain("code 666667", { extraHeaders: [AR(injected), sig] }), { to: "q2@hunt.example" });
    // A ")" closing Cloudflare's comment early, then an injected result. Caught by the envelope
    // check, and (q3b, plain envelope as if it came via HELO) by the result-count check, even
    // with a fake DKIM-Signature added to match.
    const closer = "mx.cloudflare.net; dkim=fail header.d=target.example; spf=pass (domain of a)b; dkim=pass header.d=target.example (c@evil.example) smtp.mailfrom=a";
    await deliver(plain("code 666668", { extraHeaders: [AR(closer), sig] }), { to: "q3@hunt.example", from: "a)b; dkim=pass header.d=target.example (c@evil.example" });
    await deliver(plain("code 666671", { extraHeaders: [AR(closer), sig] }), { to: "q3b@hunt.example" });
    // A second, injected dmarc=pass.
    await deliver(plain("code 666672", { extraHeaders: [AR("mx.cloudflare.net; dmarc=none header.from=evil.example; spf=none smtp.helo=x; dmarc=pass header.from=target.example")] }), { to: "q6@hunt.example" });
    // More dkim=pass results than DKIM-Signature headers.
    await deliver(plain("code 666669", { extraHeaders: [AR("mx.cloudflare.net; dkim=pass header.d=target.example; dkim=pass header.d=other.example")] }), { to: "q4@hunt.example" });
    // header.d that is not a plain hostname.
    await deliver(plain("code 666670", { extraHeaders: [AR("mx.cloudflare.net; dkim=pass header.d=target.example\\x"), sig] }), { to: "q5@hunt.example" });
    for (const to of ["q1", "q2", "q3", "q3b", "q4", "q5", "q6"]) {
      const auth = (await apiJson(`/api/emails?to=${to}@hunt.example`)).body.emails[0].auth;
      expect(auth.verified_domains, to).toEqual([]);
    }
    expect((await apiJson("/api/emails?from_domain=target.example")).body.emails).toHaveLength(0);
    expect((await apiJson("/api/wait?q=666&from_domain=target.example&since=0&timeout=1")).status).toBe(204);
  });

  it("trusts Cloudflare's real header for IPv6 senders and platform relays (quoted remote-ip)", async () => {
    // Shape of a HackerOne relay forwarded by Gmail over IPv6, as Cloudflare's MX writes it.
    const ar = AR(
      "mx.cloudflare.net; dkim=pass header.d=wearehackerone.com header.s=s1 header.b=abc; dkim=pass header.d=amazonses.com header.s=s2 header.b=def; " +
        "dmarc=pass header.from=wearehackerone.com policy.dmarc=reject; spf=none (mx.cloudflare.net: no SPF records found for postmaster@mail-yx1.google.example) smtp.helo=mail-yx1.google.example; " +
        'spf=pass (mx.cloudflare.net: domain of someone+caf_=bb=hunt.example@forwarder.example designates 2001:db8::b133 as permitted sender) smtp.mailfrom=someone+caf_=bb=hunt.example@forwarder.example; arc=pass smtp.remote-ip="2001:db8::b133"',
    );
    const relay = plain("Your verification code is 731731", {
      from: "Target via HackerOne <noreply@wearehackerone.com>",
      to: "you+acme-k7q2x@wearehackerone.com",
      extraHeaders: [ar, "DKIM-Signature: v=1; d=wearehackerone.com; s=s1; b=abc", "DKIM-Signature: v=1; d=amazonses.com; s=s2; b=def"],
    });
    await deliver(relay, { to: "bb@hunt.example", from: "someone+caf_=bb=hunt.example@forwarder.example" });
    const q = encodeURIComponent("you+acme-k7q2x@wearehackerone.com");
    const hit = (await apiJson(`/api/wait?to=bb@hunt.example&q=${q}&from_domain=wearehackerone.com&since=0&timeout=1`)).body;
    expect(hit.codes).toContain("731731");
    expect(hit.auth).toMatchObject({ dkim: "pass", dmarc: "pass", verified_domains: ["wearehackerone.com", "amazonses.com"] });
    expect(hit.match_count).toBe(1);
  });

  it("wait reports how many messages matched since the trigger", async () => {
    const since = Date.now() - 1;
    await deliver(signed("acme.example"), { to: "w2@hunt.example" });
    await deliver(plain("spoof 111111"), { to: "w2@hunt.example" });
    const r = (await apiJson(`/api/wait?to=w2@hunt.example&since=${since}&timeout=1`)).body;
    expect(r.match_count).toBe(2);
    const v = (await apiJson(`/api/wait?to=w2@hunt.example&since=${since}&from_domain=acme.example&timeout=1`)).body;
    expect(v.codes).toContain("424242");
    expect(v.match_count).toBe(1);
  });
});

describe("abuse limits", () => {
  it("evicts unread mail before read mail when the store is full", async () => {
    const e = { ...env, MAX_STORE_MB: "1" } as Env;
    const big = (n: number) => plain(Array.from({ length: 300_000 }, (_, i) => String.fromCharCode(33 + ((i * 7919 + n) % 90))).join(""));
    await deliver(big(1), { to: "real@hunt.example" }, e);
    await apiJson("/api/emails?to=real@hunt.example");
    for (let i = 0; i < 6; i++) await deliver(big(i + 2), { to: `junk${i}@hunt.example` }, e);
    const left = (await apiJson("/api/emails?limit=50&text=0")).body.emails.map((m: any) => m.to);
    expect(left).toContain("real@hunt.example");
    expect(left.length).toBeLessThan(7);
    const stats = (await apiJson("/api/stats")).body;
    expect(stats.stored_bytes).toBeLessThanOrEqual(1024 * 1024);
    const sum = await env.DB.prepare("SELECT COALESCE(SUM(stored_size),0) AS s FROM messages").first<{ s: number }>();
    expect(stats.stored_bytes).toBe(sum!.s);
  });

  it("stores oversized mail truncated", async () => {
    const e = { ...env, MAX_MESSAGE_KB: "64" } as Env;
    await deliver(plain("code 135135 " + "y".repeat(200_000)), { to: "huge@hunt.example" }, e);
    const id = (await apiJson("/api/emails?to=huge@hunt.example")).body.emails[0].id;
    const m = (await apiJson(`/api/emails/${id}`)).body;
    expect(m.raw_truncated).toBe(true);
    expect(m.raw_size).toBeGreaterThan(200_000);
    expect(m.codes).toContain("135135");
    const raw = await SELF.fetch(`${BASE}/api/emails/${m.id}/raw`, { headers: H });
    expect((await raw.arrayBuffer()).byteLength).toBe(64 * 1024);
  });

  it("a read never retries a parse that already failed once; the cron does", async () => {
    await deliver(plain("code 246246"), { to: "retry@hunt.example" });
    await env.DB.prepare("UPDATE messages SET parse_attempts = 1").run();
    expect((await apiJson("/api/emails?to=retry@hunt.example")).body.emails[0].parse_status).toBe("pending");
    await worker.scheduled(createScheduledController({ scheduledTime: Date.UTC(2026, 0, 1, 0, 5) }), env);
    expect((await apiJson("/api/emails?to=retry@hunt.example")).body.emails[0].parse_status).toBe("ok");
  });

  it("simple-list raw works past D1's 100-parameter limit and stays within a byte budget", async () => {
    for (let i = 0; i < 120; i++) await deliver(plain(`m${i}`), { to: "many@hunt.example" });
    const rows = (await apiJson("/emails?to=many@hunt.example&limit=150")).body;
    expect(rows).toHaveLength(120);
    expect(rows.every((m: any) => typeof m.raw === "string")).toBe(true);
  });

  it("refuses every key when API_KEY is too short", async () => {
    const weak = { ...env, API_KEY: "short" } as Env;
    const res = await worker.fetch(new Request(`${BASE}/api/stats`, { headers: { "x-api-key": "short" } }), weak);
    expect(res.status).toBe(401);
  });
});

describe("ui", () => {
  async function login(): Promise<string> {
    const res = await SELF.fetch(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ key: KEY }), redirect: "manual" });
    expect(res.status).toBe(303);
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }

  it("redirects to login, rejects a wrong key, accepts the right one", async () => {
    const res = await SELF.fetch(`${BASE}/inbox`, { redirect: "manual" });
    expect(res.headers.get("location")).toBe(`${ROOT}/login`);
    const wrong = await SELF.fetch(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ key: "nope" }), redirect: "manual" });
    expect(wrong.status).toBe(401);
    expect(await login()).toMatch(/^__Host-huntmail=\d+\.[0-9a-f]{64}$/);
  });

  it("lists and shows messages with an embedded signed view", async () => {
    await deliver(plain("code 424242", { subject: "<img src=x onerror=alert(1)>" }));
    const cookie = await login();
    const inbox = await SELF.fetch(`${BASE}/inbox`, { headers: { cookie } });
    expect(inbox.status).toBe(200);
    expect(inbox.headers.get("content-security-policy")).toContain("default-src 'none'");
    const page = await inbox.text();
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("424242");
    const id = page.match(/href="\/p7f3a9c2e8b14d6f0a5c\/inbox\/([0-9a-f]{28})"/)![1];
    const detail = await (await SELF.fetch(`${BASE}/inbox/${id}`, { headers: { cookie } })).text();
    expect(detail).toMatch(/<iframe src="https:\/\/huntmail\.test\/p7f3a9c2e8b14d6f0a5c\/view\/[0-9a-f]{28}\/body\?t=\d+\.0\.[0-9a-f]{64}" sandbox=""/);
    const raw = await SELF.fetch(`${BASE}/inbox/${id}/raw`, { headers: { cookie } });
    expect(await raw.text()).toContain("code 424242");
  });

  it("codes are copy buttons; favicon and the copy script are served", async () => {
    await deliver(plain("Your verification code is 515151"));
    const cookie = await login();
    const inbox = await SELF.fetch(`${BASE}/inbox`, { headers: { cookie } });
    expect(inbox.headers.get("content-security-policy")).toContain(`script-src ${BASE}/ui.js;`);
    const page = await inbox.text();
    expect(page).toContain('<button type="button" class="chip code" data-copy="515151"');
    expect(page).toContain(`<link rel="icon" type="image/svg+xml" href="${ROOT}/favicon.svg">`);
    expect(page).toContain("HuntMail</a>");
    expect(page).not.toContain("Older →");
    expect(page).toMatch(/<tr data-href="\/p7f3a9c2e8b14d6f0a5c\/inbox\/[0-9a-f]{28}">/);
    const id = page.match(/href="\/p7f3a9c2e8b14d6f0a5c\/inbox\/([0-9a-f]{28})"/)![1];
    expect(await (await SELF.fetch(`${BASE}/inbox/${id}`, { headers: { cookie } })).text()).toContain('data-copy="515151"');
    const icon = await SELF.fetch(`${BASE}/favicon.svg`);
    expect(icon.headers.get("content-type")).toBe("image/svg+xml");
    expect(await icon.text()).toMatch(/^<svg /);
    const js = await SELF.fetch(`${BASE}/ui.js`);
    expect(js.headers.get("content-type")).toContain("text/javascript");
    expect(await js.text()).toContain("clipboard");
  });

  it("rejects forged session cookies", async () => {
    const res = await SELF.fetch(`${BASE}/inbox`, { headers: { cookie: `__Host-huntmail=9999999999.${"a".repeat(64)}` }, redirect: "manual" });
    expect(res.status).toBe(303);
  });

  it("serves pages in the theme the cookie picked, and ignores anything else", async () => {
    const htmlTag = async (cookie: string) => (await (await SELF.fetch(`${BASE}/login`, { headers: { cookie } })).text()).match(/<html[^>]*>/)![0];
    expect(await htmlTag("")).toBe("<html>");
    expect(await htmlTag("hm-theme=dark.nord")).toBe('<html data-theme="dark" data-palette="nord">');
    expect(await htmlTag("a=1; hm-theme=light.graphite; b=2")).toBe('<html data-theme="light" data-palette="graphite">');
    expect(await htmlTag("hm-theme=system.midnight")).toBe("<html>");
    expect(await htmlTag("hm-theme=system.nord")).toBe('<html data-palette="nord">');
    for (const bad of ['hm-theme=dark.nord"><script>', "hm-theme=sepia.nord", "hm-theme=dark.nordx", "xhm-theme=dark.nord", "hm-theme=DARK.NORD"]) {
      expect(await htmlTag(bad)).toBe("<html>");
    }
    // The menu is on every page, logged in or not, and ui.js runs it.
    const cookie = `${await login()}; hm-theme=dark.graphite`;
    const inbox = await (await SELF.fetch(`${BASE}/inbox`, { headers: { cookie } })).text();
    expect(inbox).toContain('<html data-theme="dark" data-palette="graphite">');
    expect(inbox).toContain("data-theme-menu hidden");
    for (const p of ["midnight", "nord", "graphite"]) expect(inbox).toContain(`name="tm-palette" value="${p}"`);
    expect(await (await SELF.fetch(`${BASE}/login`)).text()).toContain("data-theme-menu hidden");
    expect(await (await SELF.fetch(`${BASE}/ui.js`)).text()).toContain('document.cookie = "hm-theme="');
  });
});

describe("abuse resistance", () => {
  async function trueBytes(): Promise<number> {
    const r = await env.DB.prepare(
      `SELECT COALESCE(SUM(length(CAST(envelope_to AS BLOB)) + length(CAST(envelope_from AS BLOB)) + length(CAST(header_from AS BLOB))
         + length(CAST(header_to AS BLOB)) + length(CAST(subject AS BLOB)) + length(CAST(message_id AS BLOB)) + length(CAST(sent_at AS BLOB))
         + length(CAST(codes AS BLOB)) + length(CAST(verified_domains AS BLOB)) + length(CAST(COALESCE(text, '') AS BLOB))
         + length(CAST(links AS BLOB)) + length(CAST(attachments AS BLOB))), 0)
         + (SELECT COALESCE(SUM(length(data)), 0) FROM raw_chunks) AS n FROM messages`,
    ).first<{ n: number }>();
    return r!.n;
  }
  const counted = async () => (await apiJson("/api/stats")).body.stored_bytes as number;

  it("counts every stored byte, so control-character links and huge headers cannot hide from the cap", async () => {
    const ctl = "\u0001".repeat(3900);
    const hrefs = Array.from({ length: 24 }, (_, i) => `<a href="https://a.example/${i}${ctl}">x</a>`).join("");
    const parts = Array.from({ length: 40 }, (_, i) => ({ filename: `f${i}${"\u0002".repeat(2000)}.txt`, content: "x" }));
    await deliver(mixedWithFiles(`<html><body>${hrefs}</body></html>`, parts, { subject: "s".repeat(54_000) }), { to: "fill@hunt.example" });
    const id = (await apiJson("/api/emails?to=fill@hunt.example&text=0")).body.emails[0].id;
    const m = (await apiJson(`/api/emails/${id}`)).body;
    expect(m.parse_status).toBe("ok");
    expect(m.links.every((l: string) => !/[\u0000-\u001f]/.test(l))).toBe(true);
    expect(m.subject.length).toBeLessThanOrEqual(2048);
    expect(m.attachments.every((a: any) => !/[\u0000-\u001f]/.test(a.filename) && a.filename.length <= 256)).toBe(true);
    // The counter must never be below what is really stored.
    expect(await counted()).toBeGreaterThanOrEqual(await trueBytes());
  });

  it("migration 0004 recounts undercounted rows to their real size", async () => {
    await deliver(alternative("text", `<p><a href="https://acme.example/v">Verify</a></p>`), { to: "m4@hunt.example" });
    const id = (await apiJson("/api/emails?to=m4@hunt.example")).body.emails[0].id;
    await apiJson(`/api/emails/${id}`);
    const exact = (await env.DB.prepare("SELECT stored_size FROM messages").first<{ stored_size: number }>())!.stored_size;
    // Simulate a row whose stored_size is lower than its real size.
    await env.DB.prepare("UPDATE messages SET stored_size = 100").run();
    const sql = (env.TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((m) => m.name.startsWith("0004"))!.queries;
    for (const q of sql) await env.DB.prepare(q).run();
    expect((await env.DB.prepare("SELECT stored_size FROM messages").first<{ stored_size: number }>())!.stored_size).toBe(exact);
    expect(await counted()).toBe(exact);
  });

  it("the counter stays at or above the real size across arrival, parse and delete", async () => {
    await deliver(plain("hello 123456"), { to: "c1@hunt.example" });
    await deliver(alternative("text", `<p><a href="https://acme.example/v">Verify</a></p>`), { to: "c2@hunt.example" });
    expect(await counted()).toBeGreaterThanOrEqual(await trueBytes());
    for (const to of ["c1", "c2"]) {
      const id = (await apiJson(`/api/emails?to=${to}@hunt.example`)).body.emails[0].id;
      await apiJson(`/api/emails/${id}`);
    }
    const after = await counted();
    expect(after).toBeGreaterThanOrEqual(await trueBytes());
    // And not wildly above: the reserve is released after parsing.
    expect(after).toBeLessThan((await trueBytes()) + 2 * 1024);
    await env.DB.prepare("DELETE FROM messages").run();
    expect(await counted()).toBe(0);
  });

  it("serves only real cid images, at most 20, and drops connection hints and refresh tags", async () => {
    const refs = Array.from({ length: 5000 }, (_, i) => `<img src="cid:n${i}">`).join("");
    const hints = `<link rel="preconnect" href="https://attacker.example"><link rel=dns-prefetch href="//attacker.example"><link rel="stylesheet" href="https://cdn.example/s.css">
<meta content="0;url=https://evil.example" x=">" http-equiv="refresh"><meta http-equiv="Content-Type" content="text/html; charset=utf-8">`;
    await deliver(related(`<html><head>${hints}</head><body>${refs}<img src="cid:logo@acme"></body></html>`), { to: "cid@hunt.example" });
    const id = (await apiJson("/api/emails?to=cid@hunt.example")).body.emails[0].id;
    for (const images of [false, true]) {
      const link = (await apiJson(`/api/emails/${id}/view-link${images ? "?images=1" : ""}`)).body;
      const res = await SELF.fetch(link.body_url);
      expect(res.headers.get("x-dns-prefetch-control")).toBe("off");
      const page = await res.text();
      const served = page.match(/\/view\/[0-9a-f]{28}\/cid\//g) ?? [];
      expect(served).toHaveLength(1); // only cid:logo@acme exists in the message
      expect(page).not.toContain("preconnect");
      expect(page).not.toContain("dns-prefetch");
      expect(page).not.toMatch(/http-equiv="refresh"/i);
      expect(page).toMatch(/http-equiv="Content-Type"/);
      expect(page.includes("cdn.example/s.css")).toBe(images); // stylesheets only with remote content on
    }
  });

  it("caps the number of distinct cid images even when they all exist", async () => {
    const { rewriteEmailHtml } = await import("../src/view");
    const cids = new Set(Array.from({ length: 50 }, (_, i) => `c${i}`));
    const html = Array.from({ length: 50 }, (_, i) => `<img src="cid:c${i}"><img src="cid:c${i}">`).join("");
    const out = rewriteEmailHtml(html, "x", "1.0.a", "/r", { cids, remote: false });
    expect(new Set(out.match(/\/cid\/c\d+/g)).size).toBe(20);
  });

  it("huge From and To headers are cut before parsing and the inbox renders them", async () => {
    const to = "a@b.example,".repeat(6000);
    const from = "<".repeat(20_000) + ">z";
    await deliver(plain("big headers", { from, to }), { to: "hdr@hunt.example" });
    const m = (await apiJson("/api/emails?to=hdr@hunt.example")).body.emails[0];
    expect(m.header_to.length).toBeLessThanOrEqual(2048);
    expect(m.header_from.length).toBeLessThanOrEqual(2048);
    const res = await SELF.fetch(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ key: KEY }), redirect: "manual" });
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    expect((await SELF.fetch(`${BASE}/inbox`, { headers: { cookie } })).status).toBe(200);
  });

  it("simple-list raw is capped at 1 MB per response", async () => {
    await deliver(plain("small one"), { to: "lr@hunt.example" });
    await deliver(related("<p>big</p>", { attachmentBytes: 1_200_000 }), { to: "lr@hunt.example" });
    const rows = (await apiJson("/emails?to=lr@hunt.example")).body;
    expect(rows).toHaveLength(2);
    const big = rows.find((r: any) => !r.raw);
    expect(big.raw_truncated).toBe(true);
    expect(rows.find((r: any) => r.raw)?.raw).toContain("small one");
  });

  it("the view banner shows the envelope sender and what was verified", async () => {
    await deliver(plain("forged", { from: "PayPal Security <security@paypal.example>" }), { to: "ban@hunt.example", from: "x@evil.example" });
    const id = (await apiJson("/api/emails?to=ban@hunt.example")).body.emails[0].id;
    const link = (await apiJson(`/api/emails/${id}/view-link`)).body;
    const page = await (await SELF.fetch(link.url)).text();
    expect(page).toContain("<th>Sender</th><td>x@evil.example</td>");
    expect(page).toContain("<th>Verified</th><td>none: the From line is not verified</td>");
  });
});

describe("pagination", () => {
  it("API next_cursor walks every message once, including same-millisecond arrivals", async () => {
    for (let i = 0; i < 7; i++) await deliver(plain(`m${i}`), { to: `page${i}@hunt.example` });
    // Force ties on received_at: keyset paging must still not skip or repeat.
    await env.DB.prepare("UPDATE messages SET received_at = 1763500000000").run();
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let n = 0; n < 10; n++) {
      const r: any = (await apiJson(`/api/emails?limit=3&text=0${cursor ? `&cursor=${cursor}` : ""}`)).body;
      seen.push(...r.emails.map((m: any) => m.id));
      cursor = r.next_cursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    expect((await apiJson("/api/emails?cursor=nope")).status).toBe(400);
  });
});

describe("stats", () => {
  async function cookie(): Promise<string> {
    const res = await SELF.fetch(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ key: KEY }), redirect: "manual" });
    return res.headers.get("set-cookie")!.split(";")[0]!;
  }

  it("keeps a running total and a per-day tally instead of counting rows", async () => {
    for (let i = 0; i < 3; i++) await deliver(plain(`m${i}`), { to: `s${i}@hunt.example` });
    let st = (await apiJson("/api/stats")).body;
    expect(st).toMatchObject({ messages: 3, today: 3, parse_pending: 3, parse_failed: 0, store_failures: 0 });
    await env.DB.prepare("DELETE FROM messages WHERE envelope_to = 's0@hunt.example'").run();
    st = (await apiJson("/api/stats")).body;
    expect(st.messages).toBe(2); // live count follows deletes
    expect(st.today).toBe(3); // the day's tally does not: it records what arrived
    const real = (await env.DB.prepare("SELECT COUNT(*) AS n FROM messages").first<{ n: number }>())!.n;
    expect(st.messages).toBe(real);
  });

  it("renders the stats page with the chart, tiles and an auto-refresh box that is off by default", async () => {
    await deliver(plain("hello"), { to: "page@hunt.example", from: "x@acme.example" });
    const res = await SELF.fetch(`${BASE}/stats`, { headers: { cookie: await cookie() } });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-security-policy")).toContain(`script-src ${BASE}/ui.js`);
    const page = await res.text();
    expect(page).toContain('<svg viewBox="0 0 960 220" role="img" aria-label="Emails received per day, last 30 days">');
    expect(page.match(/<g class="col">/g)).toHaveLength(30);
    expect(page).toContain('<input type="checkbox" id="autorefresh">');
    expect(page).not.toMatch(/id="autorefresh"[^>]*checked/);
    expect(page).toContain("counts toward the 100,000 requests a day");
    expect(page).toContain("page@hunt.example");
    expect(page).toContain("acme.example");
    expect(page).toContain('class="on">Stats</a>');
    expect((await SELF.fetch(`${BASE}/stats`, { redirect: "manual" })).status).toBe(303); // needs login
  });

  it("drops tally rows older than a year in the retention run", async () => {
    await env.DB.prepare("INSERT INTO daily_stats (day, received, raw_bytes) VALUES ('2020-01-01', 5, 100), (?1, 2, 50)")
      .bind(new Date().toISOString().slice(0, 10))
      .run();
    await enforceRetention(env.DB, 30, 0);
    const days = (await env.DB.prepare("SELECT day FROM daily_stats").all<{ day: string }>()).results.map((r) => r.day);
    expect(days).toEqual([new Date().toISOString().slice(0, 10)]);
  });
});

describe("hidden base path", () => {
  const paths = ["/", "/inbox", "/login", "/api/emails", "/emails", "/health", "/favicon.ico", "/view/x", `${ROOT}x/inbox`, `/p7f3a9c2e8b14d6f0a5/inbox`, `/x${ROOT}/inbox`];
  it.each(paths)("%s is a bare 404", async (path) => {
    const res = await SELF.fetch(ORIGIN + path, { headers: H, redirect: "manual" });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not Found");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("the base path itself goes to the inbox; health lives under it", async () => {
    const res = await SELF.fetch(BASE, { redirect: "manual" });
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(`${ROOT}/inbox`);
    expect((await SELF.fetch(`${BASE}/health`)).status).toBe(200);
  });

  it("serves nothing when BASE_PATH is missing or too short", async () => {
    for (const BASE_PATH of ["", "short"]) {
      const e = { ...env, BASE_PATH } as Env;
      expect((await worker.fetch(new Request(`${ORIGIN}/${BASE_PATH}/api/stats`, { headers: H }), e)).status).toBe(404);
      expect((await worker.fetch(new Request(`${ORIGIN}/api/stats`, { headers: H }), e)).status).toBe(404);
    }
  });
});

describe("retention", () => {
  it("expires old mail and trims oldest above the size cap", async () => {
    for (let i = 0; i < 6; i++) await deliver(plain("x".repeat(2000) + i), { to: `r${i}@hunt.example` });
    await env.DB.prepare("UPDATE messages SET received_at = received_at - 40 * 86400000 WHERE envelope_to = 'r0@hunt.example'").run();
    const sizes = await env.DB.prepare("SELECT stored_size FROM messages").all<{ stored_size: number }>();
    // Sizes differ by a few bytes (each row counts its own header bytes); size the cap for 3 rows.
    const each = Math.max(...sizes.results.map((r) => r.stored_size));
    const r = await enforceRetention(env.DB, 30, each * 3 + 10);
    expect(r.expired).toBe(1);
    expect(r.trimmed).toBe(2);
    const left = (await apiJson("/api/emails")).body.emails.map((m: any) => m.to);
    expect(left).toEqual(["r5@hunt.example", "r4@hunt.example", "r3@hunt.example"]);
    const chunks = await env.DB.prepare("SELECT COUNT(*) AS n FROM raw_chunks").first<{ n: number }>();
    expect(chunks!.n).toBe(3);
  });

  it("runs from the cron handler", async () => {
    await deliver(plain("x"));
    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), env);
    await waitOnExecutionContext(ctx);
    expect((await apiJson("/api/stats")).body.messages).toBe(1);
  });
});

describe("version", () => {
  it("is the same in /health, /api/stats and package.json", async () => {
    const pkg = (await import("../package.json")).default as { version: string };
    const health = (await (await SELF.fetch(`${BASE}/health`)).json()) as { version: string };
    expect(health.version).toBe(pkg.version);
    expect((await apiJson("/api/stats")).body.version).toBe(pkg.version);
  });
});

describe("domain stats", () => {
  it("counts mail per recipient domain from a running tally and lists set-up domains with no mail", async () => {
    await deliver(plain("a"), { to: "x@One.example" });
    await deliver(plain("b"), { to: "y@one.example" });
    await deliver(plain("c"), { to: "z@two.example" });
    const st = (await apiJson("/api/stats")).body;
    expect(st.domains).toEqual([
      { domain: "one.example", received: 2, today: 2 },
      { domain: "two.example", received: 1, today: 1 },
    ]);
    // The tally outlives the messages (retention and the cap delete messages, not counts).
    await env.DB.prepare("DELETE FROM messages").run();
    expect((await apiJson("/api/stats")).body.domains[0]).toEqual({ domain: "one.example", received: 2, today: 2 });
    const res = await worker.fetch(new Request(`${BASE}/login`, { method: "POST", body: new URLSearchParams({ key: KEY }) }), env);
    const cookie = res.headers.get("set-cookie")!.split(";")[0]!;
    const page = await (
      await worker.fetch(new Request(`${BASE}/stats`, { headers: { cookie } }), { ...env, DOMAINS: "one.example, three.example" })
    ).text();
    expect(page).toContain("Domains set up");
    expect(page).toMatch(/three\.example<\/td><td class="hide-sm"><span class="mut">no mail yet/);
    expect(page).toContain("not in DOMAINS"); // two.example got mail but is not listed
    expect(page).toContain("most mail: one.example");
  });

  it("?days=N adds the daily series and mail per domain per day; without it the response is unchanged", async () => {
    await deliver(plain("a"), { to: "x@one.example" });
    await deliver(plain("b"), { to: "y@two.example" });
    await deliver(plain("c"), { to: "z@two.example" });
    const plain0 = (await apiJson("/api/stats")).body;
    expect(plain0.days).toBeUndefined();
    expect(plain0.domain_days).toBeUndefined();
    const st = (await apiJson("/api/stats?days=30")).body;
    const today = new Date().toISOString().slice(0, 10);
    expect(st.days).toHaveLength(30);
    expect(st.days.at(-1)).toMatchObject({ day: today, received: 3 });
    expect(st.days.at(-1).raw_bytes).toBeGreaterThan(0);
    expect(st.days[0].received).toBe(0);
    expect(st.today).toBe(3);
    expect(st.domain_days).toEqual([
      { day: today, domain: "one.example", received: 1 },
      { day: today, domain: "two.example", received: 2 },
    ]);
    expect((await apiJson("/api/stats?days=1")).body.days).toHaveLength(1);
    expect((await apiJson("/api/stats?days=400")).body.days).toHaveLength(400);
    for (const bad of ["0", "401", "x", "-1", "1.5", ""]) expect((await apiJson(`/api/stats?days=${bad}`)).status).toBe(400);
  });

  it("migration 0007 backfills the tally from stored mail", async () => {
    await deliver(plain("a"), { to: "x@back.example" });
    await env.DB.prepare("DELETE FROM domain_daily").run();
    const sql = (env.TEST_MIGRATIONS as { name: string; queries: string[] }[]).find((m) => m.name.startsWith("0007"))!.queries;
    const insert = sql.find((q) => q.startsWith("INSERT INTO domain_daily"))!;
    await env.DB.prepare(insert).run();
    expect((await apiJson("/api/stats")).body.domains).toEqual([{ domain: "back.example", received: 1, today: 1 }]);
  });
});
