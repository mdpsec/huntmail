# Changelog

All notable changes to HuntMail. Versions follow [Semantic Versioning](https://semver.org/):
the API under `<base>/api`, the configuration variables and the database
(migrated in place by `scripts/setup.sh`) stay compatible within a major
version.

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
