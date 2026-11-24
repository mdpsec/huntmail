// Newsletters and blocks.
//
// A message is "bulk" when it carries newsletter headers and its subject does not look like
// account mail. Many sites send their verify and reset mail through the same mailing services as
// their newsletters, with an unsubscribe header on every message, so the headers alone never
// decide: the subject guard runs at arrival, and the parse later rules out anything with a code
// or an action link (see NEWSLETTER_SQL in store.ts). Unparsed mail is never a newsletter.

/** Subjects that look like account mail: never treated as newsletters, never blocked as one. */
export const ACCOUNT_SUBJECT = new RegExp(
  [
    // English. Kept to phrases account mail uses: job alerts and offers say "Security Consultant",
    // "Account Manager" or "Code Reviewer" too.
    "verif|confirm|activat|password|passcode|pass code|one[- ]?time|\\botp\\b|sign[- ]?in|log[- ]?in|sign[- ]?on|\\b2fa\\b|\\bmfa\\b|two[- ]factor|multi[- ]?factor|magic link|reset",
    "security (alert|notice|notification|code|check|warning|update|key|question|issue|event)|unusual (activity|sign|log)|suspicious|new device",
    "your (\\w+ )?(code|account|pin)\\b|account (verification|confirm|security|update|created|activation|locked|alert|recovery|change|access)|new account|(verification|security|login|confirmation|access|auth\\w*) code|\\bcode (is|:)",
    "welcome (to|aboard)|registration|sign[- ]?up|(you're|you are|you've been|you have been) invited|invit(e|es|ed) you|accept (the |your )?invit|access (code|request|granted|link)|organi[sz]ation|removed from|added to",
    // Spanish, Portuguese, French, German, Italian, Dutch
    "contrase|senha|mot de passe|passwort|wachtwoord|código|codice|cuenta|conta\\b|compte|konto|bestätig|anmeld|connexion|inicio de sesi|accesso|inloggen",
    // Japanese, Chinese, Korean: log in, verify, confirm, password, code, invite, security, account, register
    "ログイン|認証|確認|パスワード|コード|招待|セキュリティ|アカウント|登録|登录|登錄|验证|驗證|密码|密碼|验证码|账户|帳戶|账号|邀请|安全|로그인|인증|비밀번호|코드|초대|보안|계정",
  ].join("|"),
  "i",
);

/** Newsletter headers: List-Unsubscribe, List-Id, or Precedence bulk/list/junk. */
export function hasBulkHeaders(headers: Headers): boolean {
  return headers.has("list-unsubscribe") || headers.has("list-id") || /^\s*(bulk|list|junk)\b/i.test(headers.get("precedence") ?? "");
}

export function isBulk(headers: Headers, subject: string): boolean {
  return hasBulkHeaders(headers) && !ACCOUNT_SUBJECT.test(subject);
}

/** The domain of the first address in a From header value ("Name <a@b.example>" or "a@b.example"), lowercased. */
export function fromDomain(headerFrom: string): string {
  const m = /<[^<>@\s]*@([^<>@\s]+)>/.exec(headerFrom) ?? /[^\s<>@,;"]+@([^\s<>@,;"]+)/.exec(headerFrom);
  return (m?.[1] ?? "").toLowerCase().replace(/\.+$/, "");
}

/** The domain and each parent with at least two labels: a.b.example gives a.b.example, b.example. */
export function domainSuffixes(domain: string): string[] {
  const labels = domain.split(".").filter(Boolean).slice(-10);
  const out: string[] = [];
  for (let i = 0; i <= labels.length - 2; i++) out.push(labels.slice(i).join("."));
  return out;
}

export type BlockKind = "sender" | "recipient" | "prefix";
export type BlockScope = "newsletters" | "all";

export interface Block {
  id: number;
  kind: BlockKind;
  value: string;
  scope: BlockScope;
  created_at: string;
  hits: number;
  last_hit: string | null;
}

const DOMAIN_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const ADDRESS_RE = /^[^\s@<>]{1,64}@[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const PREFIX_RE = /^[a-z0-9._+@-]{3,254}$/; // the same rules as the to_prefix filter

/** Checks and normalizes a block request; returns an error message or the block's fields. */
export function parseBlock(input: unknown): { kind: BlockKind; value: string; scope: BlockScope } | string {
  if (!input || typeof input !== "object") return "send JSON: {kind, value, scope}";
  const { kind, value, scope } = input as Record<string, unknown>;
  if (kind !== "sender" && kind !== "recipient" && kind !== "prefix") return "kind is sender, recipient or prefix";
  if (typeof value !== "string") return "value is required";
  const v = value.trim().toLowerCase();
  if (kind === "sender") {
    if (v.length > 253 || !DOMAIN_RE.test(v)) return "a sender block takes a domain name";
    if (scope !== undefined && scope !== "newsletters" && scope !== "all") return "scope is newsletters or all";
    return { kind, value: v, scope: scope ?? "newsletters" };
  }
  if (scope !== undefined && scope !== "all") return "recipient and prefix blocks have scope all";
  if (kind === "recipient" && (v.length > 254 || !ADDRESS_RE.test(v))) return "a recipient block takes an email address";
  if (kind === "prefix" && !PREFIX_RE.test(v)) return "a prefix block takes 3-254 characters: letters, digits and . _ + - @";
  return { kind, value: v, scope: "all" };
}

/** The block that applies to this arrival, if any. One query. */
export async function matchBlock(db: D1Database, m: { to: string; headerFrom: string; bulk: boolean }): Promise<{ id: number } | null> {
  const suffixes = domainSuffixes(fromDomain(m.headerFrom));
  const senders = suffixes.length ? `(kind = 'sender' AND value IN (${suffixes.map((_, i) => `?${i + 3}`).join(", ")}) AND (scope = 'all' OR ?2 = 1)) OR ` : "";
  return db
    .prepare(
      `SELECT id FROM blocks WHERE ${senders}(kind = 'recipient' AND value = ?1) OR (kind = 'prefix' AND substr(?1, 1, length(value)) = value) LIMIT 1`,
    )
    .bind(m.to, m.bulk ? 1 : 0, ...suffixes)
    .first<{ id: number }>();
}

export async function noteBlockHit(db: D1Database, id: number, now: number): Promise<void> {
  await db.batch([
    db.prepare(`UPDATE blocks SET hits = hits + 1, last_hit = ?2 WHERE id = ?1`).bind(id, now),
    db.prepare(`INSERT INTO meta (k, v) VALUES ('blocked', 1) ON CONFLICT (k) DO UPDATE SET v = v + 1`),
  ]);
}

interface BlockRow {
  id: number;
  kind: BlockKind;
  value: string;
  scope: BlockScope;
  created_at: number;
  hits: number;
  last_hit: number | null;
}

const toBlock = (r: BlockRow): Block => ({
  ...r,
  created_at: new Date(r.created_at).toISOString(),
  last_hit: r.last_hit ? new Date(r.last_hit).toISOString() : null,
});

export async function listBlocks(db: D1Database): Promise<Block[]> {
  const { results } = await db.prepare(`SELECT * FROM blocks ORDER BY created_at DESC, id DESC LIMIT 1000`).all<BlockRow>();
  return results.map(toBlock);
}

/**
 * Adds a block, or returns the existing one for the same kind and value (with the new scope).
 * `created` is false when it already existed.
 */
export async function addBlock(db: D1Database, b: { kind: BlockKind; value: string; scope: BlockScope }, now = Date.now()): Promise<{ block: Block; created: boolean }> {
  const inserted = await db
    .prepare(`INSERT INTO blocks (kind, value, scope, created_at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT (kind, value) DO NOTHING RETURNING *`)
    .bind(b.kind, b.value, b.scope, now)
    .first<BlockRow>();
  if (inserted) return { block: toBlock(inserted), created: true };
  const existing = await db
    .prepare(`UPDATE blocks SET scope = ?3 WHERE kind = ?1 AND value = ?2 RETURNING *`)
    .bind(b.kind, b.value, b.scope)
    .first<BlockRow>();
  return { block: toBlock(existing!), created: false };
}

export async function removeBlock(db: D1Database, id: number): Promise<boolean> {
  const r = await db.prepare(`DELETE FROM blocks WHERE id = ?1`).bind(id).run();
  return (r.meta.changes ?? 0) > 0;
}

export const MAX_BLOCKS = 1000;

export async function countBlocks(db: D1Database): Promise<number> {
  return (await db.prepare(`SELECT COUNT(*) AS n FROM blocks`).first<{ n: number }>())?.n ?? 0;
}
