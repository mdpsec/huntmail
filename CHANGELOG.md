# Changelog

All notable changes to HuntMail. Versions follow [Semantic Versioning](https://semver.org/):
the API under `<base>/api`, the configuration variables and the database
(migrated in place by `scripts/setup.sh`) stay compatible within a major
version.

## v1.6.0 (2026-11-24)

- Top senders: `GET /api/senders` (`days`, default 7) lists the sites that sent
  the most mail, with newsletter counts, size and whether a block covers them.
  The stats page shows the last 7 days with a Block button (newsletters only)
  on each row, and an Unblock button on blocked rows (`block_id` in the API).
  It replaces the stats page's "Top sender domains, newest 500 emails".
- Agent instructions (README): what to do when a triggered mail never arrives
  (find the block in `/api/blocks`, remove it, trigger again, say so).
- Codes: numbers in postal addresses (box, suite and unit numbers, street
  numbers, ZIP codes) are no longer taken for codes. Applies to mail parsed
  after the upgrade.
- `action`: link text needs account wording. `Reset` needs "recover your
  account" or "password recovery" rather than any "recover"; `Verify` needs
  "confirm your email", "activate your account" and the like, or a button that
  says only "Confirm" or "Activate", so promotions ("activate muscles",
  "Activate Early Access") and headlines ("Finally Confirms") are no longer
  action links. Addresses with /verify, /confirm and /activate paths still
  count. Applies to stored mail too.
- Wider pages (up to 1440 px). The stats page uses two columns on wide
  screens: the daily chart beside mail by domain, and top senders beside blocks
  and top recipients. Below 1200 px it is one column as before.

Upgrading: `git pull`, then `pnpm redeploy` (or re-run `scripts/setup.sh`). No
new migration.

## v1.5.0 (2026-11-24)

- `q` also matches the address mail arrived at (`to`), so forwarded mail,
  whose To header still names the original mailbox, is found by the address
  it was delivered to.
- `CRON_PARSE_MAX` (default `4`): messages each per-minute run parses. With
  `CRON_PARSE_DEFERRED=1` the run's byte budget is `PARSE_BYTES` per message,
  so on Workers Paid `25` clears a backlog of big mail quickly.

Upgrading: `git pull`, then `pnpm redeploy` (or re-run `scripts/setup.sh`). No
new migration.

## v1.4.0 (2026-11-24)

- `link_details` entries carry a `kind`: `action`, `unsubscribe`, `view`,
  `social`, `app`, `legal`, `support`, `image`, or `""` for content. Worked out
  when mail is read, so stored mail has it too. The inbox's message page lists
  content and the action link first and folds the rest.
- More HTML entities decoded in link text and body text (`&emsp;`, `&ndash;`,
  `&hellip;`, curly quotes, accented letters and others), including for mail
  parsed before this version.
- Newsletters: the account-subject guard uses account phrases ("security
  alert", "your account", "your code") rather than single words, so job alerts
  such as "Security Consultant" or "Account Manager" roles count as newsletters.
  Applies to mail arriving after the upgrade.

Upgrading: `git pull`, then `pnpm redeploy` (or re-run `scripts/setup.sh`). No
new migration.

## v1.3.0 (2026-11-24)

- Newsletters: `newsletter` on every message (newsletter headers, parsed, no
  code, no action link, no account-style subject); `newsletters=hide|only` on
  lists; hidden in the inbox by default; evicted first by the size cap;
  `NEWSLETTER_RETENTION_DAYS` to keep them for fewer days. `/api/stats` reports
  `newsletters` and `blocked`.
- Blocks: reject mail at arrival from a sender domain (its newsletters, or
  everything), to one address, or to an address family. `/api/blocks`, and
  buttons on the inbox's message page; blocks are listed on the stats page.
- Migration 0009: `bulk` and `has_action` columns, a newsletter index, the
  `blocks` table. Mail stored before it never counts as a newsletter.
- `sender_domain` on every message: the From header's domain, the value a
  sender block takes.
- `action`: `Reset` also matches `password/change`, `password-forgot` and
  `forgot-password` addresses.

Upgrading: `git pull`, then `pnpm redeploy` (or re-run `scripts/setup.sh`), which
applies migration 0009 before deploying. Mail already stored is never marked as a
newsletter; new mail is. Optionally set `NEWSLETTER_RETENTION_DAYS` (for example
`"7"`) in `wrangler.local.jsonc`.

## v1.2.0 (2026-11-24)

- `action` on every message: the link the mail is about (`Verify`, `Reset`,
  `Sign in` or `Invite`), picked from its links when read.
- Inbox: a Code/link column with the likeliest code, else that link (click to
  copy); the message page shows it too.

## v1.1.0 (2026-11-23)

- `/api/stats?days=N` adds mail per day (`days`) and per domain per day
  (`domain_days`); `/api/stats` also reports `parse_deferred`, big mail not
  parsed yet.
- `to_domain` filter (`/api/emails`, `/api/wait`, `/emails`): all mail for one
  recipient domain, from an index.
- `CRON_PARSE_DEFERRED` (default `0`): on Workers Paid, `1` has the per-minute
  run parse big mail too, newest first, so lists show its codes without a read.
- Migration 0008: indexes for `to_domain` and for deferred mail.

Upgrading: `git pull`, then `pnpm redeploy` (or re-run `scripts/setup.sh`), which
applies migration 0008 before deploying. On Workers Paid, also set
`CRON_PARSE_DEFERRED` to `"1"` in `wrangler.local.jsonc`.

## v1.0.0 (2026-11-23)

The first public release.

- Catch-all inbox on Cloudflare only: one Worker, one D1 database and Email
  Routing. Works on the free plan; Workers Paid ($5 a month) recommended.
- API for agents: `/api/wait` long-polls for a message (up to 50 s),
  `/api/emails` lists and filters (`to`, `to_prefix`, `subject`, `q`,
  `from_domain`, `since`, cursor paging), each message with codes, links and their link text,
  attachments and sender verdicts. A simple `/emails` array for scripts.
- Codes and links come from a parse step that runs after arrival, so arrival
  stays inside the free plan's CPU limit. Mail over 64 KB is parsed when read.
- Sandboxed, screenshot-ready render of any message through signed view links,
  with HuntMail's own header block (Sender and Verified rows).
- Sender verdicts from Cloudflare's Authentication-Results, failing closed;
  `from_domain` filters by verified sender, for platform relays such as
  HackerOne and Bugcrowd aliases.
- Web inbox with search and paging, and a stats page (per day and per domain)
  built on running counters. Light, dark or system theme in three palettes
  (Midnight, Nord, Graphite).
- Hidden under a random base path; one API key; optional own hostname and
  rate-limiting rule.
- Size cap counted to the byte, unread mail evicted first; retention in days.
- `scripts/setup.sh` for setup, more domains, key and path rotation.
- `pnpm bundle` builds a prebuilt, reproducible bundle (Worker, migrations,
  manifest) for installing through the Cloudflare API alone. `/health` and
  `/api/stats` report the running version.
