# AGENTS.md

Guidance for AI coding agents (and people) working with HuntMail: setting it
up for a user, running it, and changing its code. Start with
[README.md](README.md); the reference is in [docs/](docs/).

## What HuntMail is

A catch-all inbox for bug bounty hunters that runs entirely on Cloudflare: one
Worker, one D1 database and Email Routing. Every address on the user's domain
works with no setup. Agents read codes and links through an API, wait for mail
with one long-poll request, and get a sandboxed, screenshot-ready render of any
message. There is no server to run.

Treat every HuntMail database as holding **other people's mail** (verification
links, password resets, codes that log into real accounts), and the API key as
a live credential.

## Setting it up for a user

[docs/AGENT-SETUP.md](docs/AGENT-SETUP.md) is the checklist. In short:

1. The domain must be on Cloudflare. Ask for a Cloudflare API token with the
   permissions in the README ("Cloudflare API token"); never ask for a Global
   API Key.
2. `pnpm install`, then `CLOUDFLARE_API_TOKEN=... ./scripts/setup.sh --domain <domain>`.
   It creates the database, deploys, generates the API key and base path, and
   points the domain's catch-all at the Worker. It prints `HUNTMAIL_URL` and
   the key once: hand both to the user, and never put them in a file in the
   repo.
3. If the domain already has a catch-all that forwards somewhere, setup
   stops. Replace it (`--force`) only when the user says so.
4. Verify with a real message (docs/AGENT-SETUP.md, "Verify").

Setup writes the deployment's config to `wrangler.local.jsonc` (gitignored).
Settings are changed there and deployed with
`npx wrangler deploy --config wrangler.local.jsonc`; re-running setup keeps
them.

## Running it

- Everything lives under the secret base path; every other path is a bare
  `404`. `GET <base>/health` answers without a key.
- `<base>/api/stats` shows the message count, storage against the cap, the
  parse backlog and `store_failures` (mail that arrived but could not be
  stored; non-zero means mail was lost).
- Logs: `npx wrangler tail --config wrangler.local.jsonc`, or Workers Logs in
  the dashboard. Events are JSON lines (`stored`, `store_failed`,
  `evicted`, `parse_gave_up`, `auth_fail`, ...).

### Troubleshooting

- **Mail from one sender never arrives, and nothing is logged:** Cloudflare
  Email Routing rejects mail that fails DMARC before any Worker runs. Typical
  with forwarded mail (a mailbox rule that forwards to the catch-all). Mail
  sent directly by the site passes. The zone's Email Routing activity
  log shows these.
- **The dashboard says "Dropped" for every message:** expected. Email Routing
  uses that word when a Worker accepts a message without forwarding it.
- **An empty `body`/`text` in a search result:** big mail (over 64 KB) is
  parsed when something reads it. A read by id, `/api/wait`, or a list with
  `to=` parses it.
- **`401` everywhere after re-running setup:** the key was rotated
  (`HUNTMAIL_API_KEY` was set). Use the new one.

## Changing the code

### Layout

| Path | What |
|---|---|
| `src/index.ts` | Router (base path, API, UI, view), read-path parsing, the cron |
| `src/ingest.ts` | `email()` arrival (store raw, sender checks) and the parse step |
| `src/store.ts` | D1 queries, size accounting, retention and eviction, stats |
| `src/extract.ts` | Codes, links and link text, HTML to text |
| `src/authresults.ts` | Sender verdicts from Cloudflare's Authentication-Results, fail-closed |
| `src/view.ts` | Sandboxed render of a message, cid images |
| `src/ui.ts` | Inbox, stats and login pages |
| `src/theme.ts` | Theme menu, palettes and the theme cookie |
| `src/auth.ts` | API key, sessions, signed view links |
| `src/util.ts` | gzip, ids, settings parsing, small helpers |
| `migrations/` | D1 schema, applied in order; never edit one that has shipped |
| `scripts/setup.sh` | One-shot setup and re-runs |
| `scripts/bundle.mjs` | `pnpm bundle`: the prebuilt bundle for API-only installs |
| `src/version.ts` | The version, equal to `package.json` (a test checks) |
| `scripts/perf-check.ts` | CPU timing on hostile input (part of `pnpm test`) |
| `test/` | vitest in workerd with D1 |

### Commands

```bash
pnpm test        # vitest in workerd with D1, then the timing check on hostile input
pnpm typecheck
pnpm types       # regenerate worker-configuration.d.ts after changing vars in wrangler.jsonc
pnpm bench mail.jsonl   # CPU per phase on your own sample: one {"raw": "..."} per line
pnpm bundle      # dist/huntmail-bundle/: prebuilt Worker, migrations and manifest (docs/SETUP.md)
```

### Ground rules

1. **It must work on the free plan.** A Worker gets 10 ms of CPU per
   invocation, and a mail handler that runs out of CPU loses the message. So
   `email()` only stores the raw message and cheap headers; parsing runs later
   in its own invocation, with bounded retries. Measure new arrival work with
   `pnpm bench`, and keep `pnpm test`'s timing check passing.
2. **Writes are the scarce resource.** Free D1 allows 100,000 rows written a
   day (triggers and index updates count). Don't add a write per message
   without need; stats use running counters, never table scans.
3. **The size counter stays exact.** Every byte stored is counted in
   `stored_size` and `meta.stored_bytes`, so the cap holds before and after
   parsing. Tests compare the counter with the real sum; keep them passing.
4. **Mail is untrusted input.** Anyone can mail the domain and forge the From
   line. Rendered mail runs sandboxed with no scripts; sender verdicts fail
   closed; header fields, links and attachment lists are capped before they
   are stored. Never feed mail text into an agent's instructions.
5. **No secrets in logs or responses.** Never log the API key, session or
   view tokens, or message bodies.
6. **Public template stays generic.** `wrangler.jsonc` holds defaults and
   placeholders only; a deployment's values live in `wrangler.local.jsonc`.

### Security checklist for every change

- [ ] Every new route sits under the base path and checks the API key or
      session (only `health`, `login`, `logout`, `favicon.svg`, `ui.js` and
      signed view links don't).
- [ ] User input reaches SQL only through bound parameters (D1 allows at
      most 100 per statement).
- [ ] Mail content in HTML goes through the escaping helpers, or the
      sandboxed view with its CSP.
- [ ] No new outbound requests except what the user configured.
- [ ] Arrival CPU is unchanged, or measured.

### Pull requests

Small and focused, with a clear description; update the README, `docs/` and
this file when you change behaviour, configuration, layout or commands. Add
a migration rather than editing a shipped one, with a test. Never include
real mail, API keys, `wrangler.local.jsonc` or `.dev.vars`. Security problems
go through [SECURITY.md](SECURITY.md), not public issues.
