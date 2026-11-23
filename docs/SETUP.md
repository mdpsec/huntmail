# Setup

Time: about 10 minutes once the domain is on Cloudflare. Cost: the domain only; HuntMail runs on the Cloudflare free plan. For active hunting, Workers Paid ($5 a month) is recommended: see [Free plan limits](#free-plan-limits-that-matter).

## 1. Requirements

- A domain using Cloudflare DNS (nameservers pointed at Cloudflare). Any registrar works. Use a domain you do not use for real email: Email Routing takes over its MX records.
- Node.js 22.12+, `pnpm` or `npm`, `curl`, `jq`, `openssl`.

## 2. API token

Cloudflare dashboard, **My Profile, API Tokens, Create Token, Create Custom Token**:

| Type | Permission | Access | Used for |
|---|---|---|---|
| Account | Workers Scripts | Edit | deploy the Worker, set the API key and base path secrets |
| Account | D1 | Edit | create the database, run migrations |
| Account | Account Settings | Read | look up the workers.dev subdomain |
| Zone | Zone Settings | Edit | turn on Email Routing (adds MX and SPF) |
| Zone | Email Routing Rules | Edit | point the catch-all at the Worker |
| Zone | Zone | Read | find the zone by name |

**Zone Resources**: Include, Specific zone, your domain. **Account Resources**: Include, your account.

Optional:

| Type | Permission | Access | Used for |
|---|---|---|---|
| Account | Email Routing Addresses | Edit | verify addresses for `FORWARD_TO` |
| Account | Workers Tail | Read | `wrangler tail` live logs |
| Account | Workers Observability | Read | query stored Workers Logs |
| Account | Account Analytics | Read | CPU time per invocation from GraphQL analytics |

The token is only needed for setup and updates. The running Worker never sees it.

## 3. Run setup

```bash
git clone https://github.com/mdpsec/huntmail.git && cd huntmail
pnpm install            # or: npm install
CLOUDFLARE_API_TOKEN=... ./scripts/setup.sh --domain yourdomain.com
```

It creates the D1 database, applies migrations, deploys the Worker, generates an API key and a random base path, turns on Email Routing and sets the catch-all rule. It prints `HUNTMAIL_URL` (`https://huntmail.<sub>.workers.dev/<base path>`) and the API key once: store both. Re-running it is safe; it keeps the existing key and path unless `HUNTMAIL_API_KEY` or `HUNTMAIL_BASE_PATH` is set.

Every route lives under the base path. The bare `workers.dev` address and every other path return a plain 404, so the service is invisible to crawlers and scanners. The path is not a password (it appears in shared view links); the API key is.

If the domain already has a catch-all rule that forwards somewhere, setup stops rather than replacing it. Use `--force` to replace it.

To add another domain, run setup again with `--domain another.com`. The domain must be in the same Cloudflare account, and the token's Zone Resources must include it. Setup reuses the Worker, database, API key and base path, and only turns on Email Routing and the catch-all for the new domain. All domains share one inbox; `to=` filters by full address.

## 4. Check it

Send any mail to `anything@yourdomain.com`, then:

```bash
curl -s -H "X-Api-Key: $HUNTMAIL_API_KEY" "$HUNTMAIL_URL/api/emails?limit=1" | jq
```

Or open `$HUNTMAIL_URL/inbox` and log in with the key.

If mail from one sender never shows up and nothing is logged: Email Routing rejects mail that fails DMARC before any Worker runs, which mostly hits forwarded mail (a mailbox rule that forwards to your domain). Mail sent directly by the site passes. Your zone's Email Routing activity log lists these. The same log labels every message HuntMail accepted as "Dropped": that is Cloudflare's word for a Worker accepting a message without forwarding it.

## Settings

`wrangler.jsonc` is the public template with the defaults below. Setup writes your deployment's config to `wrangler.local.jsonc` (not committed). Change values under `vars` there, then run `pnpm redeploy` (applies any new migrations, then deploys with `wrangler.local.jsonc`). Re-running setup keeps your `vars`, `routes` and `workers_dev`, and adds any new settings from the template with their defaults.

| Var | Default | |
|---|---|---|
| `DOMAINS` | empty | Your mail domains, comma-separated. Setup adds each `--domain` it sets up. Only the stats page uses it, to count set-up domains and list those with no mail yet. |
| `RETENTION_DAYS` | `30` | Older mail is deleted hourly. `0` keeps mail until the size cap. |
| `MAX_STORE_MB` | `350` | Enforced on every arrival. Above it, unread mail is evicted first, then the oldest read mail. A free D1 database holds 500 MB; the gap leaves room for indexes. |
| `MAX_MESSAGE_KB` | `4096` | Larger messages are stored truncated (headers and the start of the body). |
| `FORWARD_TO` | empty | Comma-separated addresses that also get every message. Each must be a verified Email Routing destination address. Forwarding changes the envelope recipient, so the receiving side sees the forward address, not the original one. |
| `VIEW_LINK_TTL` | `900` | Seconds a signed view link stays valid. |
| `PARSE_BYTES` | `262144` | Leading bytes of each message parsed for text, codes and links. |
| `GZIP_MAX_BYTES` | `131072` | Larger messages are stored uncompressed. |
| `TO_READ_PARSE_MAX` | `1` | Unparsed messages a per-address read (`to=`) parses before answering. `1` keeps a read inside the free plan's 10 ms CPU. On Paid use `25`, so a mailbox listing never shows an empty body. |

Rotate the key: `HUNTMAIL_API_KEY=$(openssl rand -hex 32) ./scripts/setup.sh --domain yourdomain.com`. Old view links and sessions stop working. Keys under 32 characters are refused.

Change the base path: `HUNTMAIL_BASE_PATH=$(openssl rand -hex 16) ./scripts/setup.sh --domain yourdomain.com`, then update `HUNTMAIL_URL` everywhere it is used. Old view links stop working.

### Your own hostname and rate limiting

`workers.dev` addresses cannot have WAF or rate-limiting rules. To get them, serve the Worker on a hostname in one of your zones as well. The `workers.dev` address keeps working as a fallback.

Use a random label (for example `openssl rand -hex 5`) and a Workers route, not a Workers Custom Domain. A Custom Domain gets its own certificate, and every certificate is published in Certificate Transparency logs, which scanners watch for new hostnames. A route on a proxied record is served under the zone's universal `*.yourdomain.com` certificate, so the hostname is never published:

1. DNS: add a proxied `AAAA` record for the label with content `100::` (a placeholder; the Worker answers every request, so nothing reaches it).
2. In `wrangler.local.jsonc`, add `"routes": [{ "pattern": "<label>.yourdomain.com/*", "zone_name": "yourdomain.com" }]` and deploy. Setup re-runs keep it.
3. `HUNTMAIL_URL` becomes `https://<label>.yourdomain.com/<base path>`.

The token needs **Zone, DNS, Edit** and **Zone, Workers Routes, Edit** for that zone, and **Zone, Zone WAF, Edit** for the rule below.

Then add a rate-limiting rule in that zone (Security, WAF, Rate limiting rules). The free plan allows one rule, with a 10-second period and block duration:

```
(starts_with(http.request.uri.path, "/<base path>/login") or starts_with(http.request.uri.path, "/<base path>/api/"))
```

The base path is unique, so the path alone is enough. New rules take a minute or so to take effect.

Count by IP (the free plan adds the data center), block for 10 s. Pick the threshold from your agents' polling: ten agents polling every 3 s from one machine make about 35 requests per 10 s, so 120 leaves room. `/api/wait` holds one request open for up to 50 s, so it barely counts. Failed logins and bad API keys are logged as `auth_fail` either way.

## Free plan limits that matter

| Limit | What happens |
|---|---|
| 10 ms CPU per invocation | Arrival does the minimum (store the raw message and sender checks); parsing runs later. On the live edge arrival measured about 9 ms median, 25 ms at the 90th percentile. Cloudflare lets these bursts through today (no failures in testing); strict enforcement would bounce mail, which is the main reason to use Workers Paid. Very large HTML mail can need one retry to parse or view; the raw is always kept. |
| 500 MB per D1 database | The size cap is checked on every arrival; unread mail is evicted first. Typical hunter volume keeps months. |
| 100,000 Worker requests per day | Each polled read is one request. `/api/wait` turns a polling loop into one request. The per-minute cron adds 1,440 a day. |
| 100,000 D1 rows written per day | About 15 rows per message (store, parse, indexes, read markers): roughly 6,500 messages a day. |

Workers Paid ($5 a month per account) raises CPU to 30 s and D1 to 10 GB per database. No code change is needed. On Paid, raise `MAX_STORE_MB` (up to about 9000), `PARSE_BYTES`, `GZIP_MAX_BYTES` and `TO_READ_PARSE_MAX` (25) in `wrangler.local.jsonc` and redeploy ([settings](#settings)). Full free vs paid table: [README](../README.md#cost-free-plan-vs-workers-paid).

## How it works

```
*@yourdomain.com -> Cloudflare Email Routing (catch-all) -> Worker email() -> D1
agents, browser  -> https://huntmail.<you>.workers.dev/<base path>/...  -> Worker fetch() -> D1
every minute     -> Worker scheduled() -> parse backlog, hourly retention
```

The free plan allows 10 ms of CPU per invocation, and a mail handler that runs out of CPU loses the message. So arrival does almost nothing: it reads headers the runtime already parsed, gzips small mail, and stores the raw message. Parsing text, codes and links happens on the first read or in the per-minute cron (up to 4 messages a run), in its own invocation, with bounded retries. Mail over 64 KB is never parsed in the background: it is parsed when something reads it (by id, a per-address list, `/api/wait`, or the inbox), so newsletter bursts cost nothing until opened. On the live edge, arrival measured about 9 ms of CPU (median) on real hunting mail, most of it fixed per-invocation cost rather than work that grows with message size.

## Without the script

1. `cp wrangler.jsonc wrangler.local.jsonc`, then `npx wrangler d1 create huntmail` and put its id in `wrangler.local.jsonc`.
2. `npx wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc`
3. `npx wrangler deploy --config wrangler.local.jsonc`
4. `openssl rand -hex 32 | tr -d '\n' | npx wrangler secret put API_KEY --config wrangler.local.jsonc` (keep the key)
5. `openssl rand -hex 16 | tr -d '\n' | npx wrangler secret put BASE_PATH --config wrangler.local.jsonc` (keep the path; without it every request is a 404)
6. Dashboard, your domain, **Email, Email Routing**: enable it, then **Routing rules, Catch-all address**: action **Send to a Worker**, Worker `huntmail`, enabled.
7. `HUNTMAIL_URL` is `https://huntmail.<your workers.dev subdomain>.workers.dev/<base path>`.

## Prebuilt bundle

For tools that install HuntMail through the Cloudflare API alone, with no Node or wrangler on the user's machine. `pnpm bundle` builds `dist/huntmail-bundle/`:

| File | What |
|---|---|
| `index.js` | The Worker, exactly what `wrangler deploy` uploads (one ES module) |
| `migrations/*.sql` | The D1 schema, applied in name order |
| `manifest.json` | Version, module hash, compatibility date and flags, cron, the `DB` binding, default vars, secret names and rules, migrations and their hashes |
| `LICENSE`, `THIRD_PARTY_NOTICES.md` | HuntMail's license, and postal-mime's (bundled in `index.js`) |

The same source and lockfile give the same bytes. Each GitHub release also has it as `huntmail-bundle-vX.Y.Z.zip` (its SHA-256 in the release notes), so a tool can fetch a version without building it. To install or update from it:

1. **Database.** Create a D1 database (or reuse the one in the Worker's `DB` binding). Make sure the migrations table exists: `CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)`. This is wrangler's own table, so a database set up with `scripts/setup.sh` works too.
2. **Migrations, before the code.** For each name in `manifest.migrations` not already in `d1_migrations`, in order: send the whole file plus `INSERT INTO d1_migrations (name) VALUES ('<name>');` as one `sql` string to the D1 query endpoint (`POST /accounts/<account>/d1/database/<id>/query`). Don't split files on `;`: some create triggers with `BEGIN ... END`.
3. **Worker.** `PUT /accounts/<account>/workers/scripts/<name>` as multipart: a `metadata` part (`application/json`) with `main_module`, `compatibility_date`, `compatibility_flags`, `observability` and `bindings`, and an `index.js` part (`application/javascript+module`). Bindings: `{"type": "d1", "name": "DB", "id": "<database id>"}`, one `plain_text` per var (on an update, keep the user's values and add vars new in `manifest.vars` with their defaults), and on a first install `secret_text` `API_KEY` and `BASE_PATH` (see `manifest.secret_rules`). On an update, send `"keep_bindings": ["secret_text"]` and no secrets, so the existing ones stay.
4. **Cron.** `PUT .../workers/scripts/<name>/schedules` with `[{"cron": "* * * * *"}]` (from `manifest.crons`).
5. **workers.dev.** `POST .../workers/scripts/<name>/subdomain` with `{"enabled": true}`. Routes and custom domains are separate and survive updates.
6. **Email Routing.** Point each domain's catch-all at the Worker, as setup does.
7. **Check.** `GET <base>/health` returns the new `version`.

## Remove

Disable or delete the catch-all rule (mail then bounces), then `npx wrangler delete --config wrangler.local.jsonc` and `npx wrangler d1 delete huntmail`.
