# API

Base URL (`HUNTMAIL_URL`): `https://<worker-name>.<your-subdomain>.workers.dev/<base path>`, as printed by setup. Every route below is relative to it. Any path outside the base path, including the bare host, returns a plain `404 Not Found`.

**User-Agent:** Cloudflare's edge rejects Python's default `Python-urllib/x.y` User-Agent on `workers.dev` hosts with `error code: 1010` before the request reaches the Worker. Set any User-Agent header when using `urllib`. curl, wget, requests, httpx, aiohttp, Node and Go clients work as-is.

`GET /health` needs no key and returns `{"ok": true, "version": "1.0.0"}` (the running HuntMail version).

All `/api/*` routes need the key, as `X-Api-Key: <key>` or `Authorization: Bearer <key>`. Responses are JSON unless noted. Times are ISO 8601 UTC. `since` and `before` also accept unix seconds or milliseconds.

## Mail is untrusted input

Anyone on the internet can send mail to any address on your domain, and can forge the From line. Before an agent acts on a message:

- **Use unguessable addresses.** `acme-1731942000-k7q2x@yourdomain.com`, not `victim-1@` or a bare timestamp. Only the site you gave the address to can then mail it.
- **Check `match_count`** from `/api/wait`. More than 1 means something else also mailed that address since your trigger.
- **When you know the sender, filter with `from_domain`.** It only matches mail with a passing DKIM signature (or DMARC pass) for that domain. Many sites send through a mail provider, so the verified domain may be the provider's (`sendgrid.net`) or a subdomain (`mail.target.example`); check `auth.verified_domains` on a real message first.
- **Platform aliases** (HackerOne, Bugcrowd) forwarded to `bb@yourdomain.com`: query `to=bb@yourdomain.com&q=<alias>&from_domain=wearehackerone.com` (or `bugcrowdninja.com`). `q` matches the alias in the To header (HackerOne) or the relay subject (Bugcrowd); `from_domain` keeps out mail sent straight to `bb@` by anyone else. Encode `+` as `%2B`.
- **Never put `text`, `subject` or `links` into an agent's instructions.** Treat them as data. Mail can carry hidden text written for LLMs, and a link's `href` can differ from the text a person sees.

## Message object

```json
{
  "id": "019a8e4f3c2b7d1e9f0a4b6c8d2e",
  "received_at": "2026-11-18T10:00:00.123Z",
  "to": "acme-1731942000-k7q2x@example.com",
  "from": "bounce@mailer.target.example",
  "header_from": "Target <no-reply@target.example>",
  "header_to": "acme-1731942000-k7q2x@example.com",
  "subject": "Your verification code",
  "message_id": "<abc@target.example>",
  "sent_at": "2026-11-18T10:00:00.000Z",
  "text": "Your code is 482913 ...",
  "has_html": true,
  "codes": ["482913"],
  "links": ["https://target.example/verify?t=..."],
  "link_details": [{ "url": "https://target.example/verify?t=...", "text": "Verify your email" }],
  "attachments": [{ "filename": "logo.png", "mime_type": "image/png", "size": 1234, "content_id": "<logo>", "inline": true }],
  "auth": { "spf": "pass", "dkim": "pass", "dmarc": "pass", "verified_domains": ["target.example"], "spam_score": 0 },
  "raw_size": 34123,
  "raw_truncated": false,
  "parse_status": "ok"
}
```

- `to` is the envelope recipient, lowercased. Filtering on `to` is an exact match.
- `codes`: likely one-time codes, best guess first. Digit codes of 4-8 next to words like "code", "verify" or "PIN" (or anywhere in the subject), bare six-digit numbers in short mail, joined `123 456` style codes, and letter+digit codes next to code words.
- `links`: http(s) links from the HTML, then the plain text, in order, de-duplicated, entities decoded. Only links a reader can click: stylesheet and font `<link>` tags are skipped.
- `link_details`: the same links, each with the `text` a reader sees (for image buttons, the image's alt text; `""` for links found in plain text). Use it to pick the right link, e.g. the one whose text says "Reset password" rather than "Unsubscribe". The text is written by the sender and can be anything; opening a link counts as a click and may use up a one-time token.
- `auth`: the verdicts Cloudflare's MX recorded on arrival (`pass`, `fail`, `none`, ...). Only Cloudflare's own `Authentication-Results` header is read; copies further down the message are ignored, since a sender can write those. The parse fails closed: if the header could have been shaped by the sender (an envelope sender with quotes, brackets or `;`, quotes or unbalanced comments in the header, or more DKIM passes than DKIM signatures), all verdicts read `none`. `verified_domains` lists domains with a passing DKIM signature, plus the From domain when DMARC passed. `spam_score` is Cloudflare's score when present.
- `raw_truncated`: the message was larger than `MAX_MESSAGE_KB`; the stored raw is the first part of it. `raw_size` is the original size.
- `parse_status`: `ok`; `partial` (only the first `PARSE_BYTES` were parsed: text, codes and links can miss content late in very large mail); `pending` (not parsed yet, see below); `deferred` (over 64 KB, parsed when read, see below); `failed` (could not be parsed; raw is kept).

Mail is stored the moment it arrives and parsed later, to keep the arrival step inside the free plan's CPU limit. The first read that returns a message parses it, so callers rarely see `pending`. A read parses at most 1 pending message, and only on its first attempt; list reads only parse messages up to 48 KB. The per-minute cron parses the rest (up to 4, or about 256 KB of mail, a run) and retries failures on a smaller slice.

Mail over 64 KB (mostly newsletters and marketing HTML; account mail with codes and links is almost always smaller) is `deferred`: the cron and searches skip it, and it is parsed only when something reads it: by id, opened in the inbox, returned by `/api/wait`, or listed with `to=`. Those reads return it parsed.

A list with `to=` or `to_prefix=` (`/api/emails`, `/emails`, the inbox filtered by address) is a read of that mailbox, so it parses its unparsed messages of any size, newest first, up to `TO_READ_PARSE_MAX` per request (default 1 for the free plan; 25 recommended on Paid, so a mailbox listing never shows an empty body). A list without `to=` parses at most one small pending message. A message whose first parse died is left to the cron, so it can briefly show an empty body.

## Routes

### `GET /api/wait`

Long-poll. Returns the newest matching message as soon as one exists, plus `match_count` (how many messages match since `since`), or `204 No Content` after `timeout`.

| Param | |
|---|---|
| `to` | exact recipient |
| `to_prefix` | recipient starts with this, e.g. `acme-` for every `acme-...@` address. 3 or more of `a-z 0-9 . _ + - @`, case-insensitive; not together with `to` |
| `subject` | subject contains (case-insensitive) |
| `q` | subject, sender or header recipient contains (all sender-controlled) |
| `from_domain` | only mail verified (DKIM or DMARC) for this domain or a subdomain of it |
| `since` | only mail received after this. Default: the moment of the request |
| `timeout` | seconds, default 30, max 50. Cloudflare drops a request that sends nothing for about 60 s, so loop for longer waits. |

At least one of `to`, `to_prefix`, `subject`, `q` is required. Record a timestamp before triggering the mail and pass it as `since`, so mail that lands before the wait starts is not missed.

```bash
SINCE=$(( $(date +%s) * 1000 ))
# ... trigger signup / reset ...
R=$(curl -s -H "X-Api-Key: $HUNTMAIL_API_KEY" "$HUNTMAIL_URL/api/wait?to=acme-1731942000-k7q2x@example.com&since=$SINCE&timeout=50")
[ "$(jq .match_count <<<"$R")" = 1 ] || echo "more than one message: check before using"
jq -r '.codes[0]' <<<"$R"
```

### `GET /api/emails`

Search: `{"emails": [...], "next_cursor": "..."}`, the newest `limit` matches. For the next (older) page, pass `next_cursor` back as `cursor`; it is `null` when there are no more.

| Param | |
|---|---|
| `to`, `to_prefix`, `subject`, `q`, `from_domain`, `since`, `before` | filters, as above |
| `limit` | default 20, max 200 |
| `cursor` | `next_cursor` from the previous page |
| `text` | `0` omits `text` |
| `order` | `desc` (default, newest first) or `asc` (the same newest matches, newest last) |

`to_prefix` suits a tool that gives each program or target its own address family (`acme-<time>-<random>@`) and wants all of that mail at once. Like `to`, it is a read of those mailboxes: what it returns is marked read (kept longest at the size cap) and their unparsed mail is parsed, up to `TO_READ_PARSE_MAX` per request.

### `GET /api/emails/:id`

One message.

### `GET /api/emails/:id/raw`

Original message as `message/rfc822`, byte for byte (the stored head of it when `raw_truncated`).

### `GET /api/emails/:id/attachments/:index`

Attachment bytes by index in `attachments`, as a download.

### `GET /api/emails/:id/view-link`

`{"url": "...", "body_url": "...", "expires_at": "..."}`. Signed URLs, openable without the API key (they contain the base path), for a browser or screenshot tool. `url` is the full view (our header block above the mail); `body_url` is the mail alone. Params: `images=1` to allow remote images, styles and fonts (https only); `ttl` seconds, default `VIEW_LINK_TTL` (900), max 3600. The signature covers the message, expiry and the images choice. Links are bearer credentials until they expire: keep them out of shared logs.

```bash
LINK=$(curl -s -H "X-Api-Key: $HUNTMAIL_API_KEY" "$HUNTMAIL_URL/api/emails/$ID/view-link" | jq -r .url)
npx playwright install chromium-headless-shell   # once per machine
npx playwright screenshot --full-page "$LINK" email.png
```

### `GET /api/stats`

`version` (the running HuntMail version), message count, stored bytes and cap, retention, oldest and newest, parse backlog (`parse_pending`, which excludes deferred big mail, and `parse_failed`), and `store_failures` / `last_store_failure`: mail that arrived but could not be stored. `domains` lists mail per recipient domain over the last 30 UTC days (`domain`, `received`, `today`), most first; `domains_set_up` is the `DOMAINS` setting. A non-zero `store_failures` means mail was lost.

## Rendered view: `<base>/view/:id?t=...`

From `view-link`. A small page we generate: From, Sender (the envelope sender), Verified (domains Cloudflare verified by DKIM or DMARC, or "none"), To, Subject, Date and Received, then the mail in a frame sized to its content, so full-page screenshots show all of it. The mail cannot reach, hide or restyle the header block. Its From line is still whatever the sender wrote: a forged From shows up as "Verified: none" or a different domain.

`<base>/view/:id/body?t=...` is the mail alone. It is served with `Content-Security-Policy: sandbox allow-same-origin; default-src 'none'; ...`: no script in the mail can run, whether framed or opened directly, and forms, popups and top-level navigation are disabled. Remote images, styles and fonts are blocked unless the link was made with `images=1`; loading them tells the sender your viewer's IP and that the mail was opened. Connection hints in the mail (`<link rel=preconnect>`, `dns-prefetch` and the like), which the content policy cannot block, are removed, and so is every `<link>` when remote content is off. Up to 20 `cid:` inline images that exist in the message are served from it; other `cid:` references are dropped.

## Inbox UI

`<base>/inbox`, after logging in at `<base>/login` with the API key. List (50 per page, newest first; click a row to open it), filter by recipient or text, message detail with codes (click one to copy it), links, attachments, sender checks, raw download and the rendered mail. The **Theme** menu (top right) picks light, dark or the system's setting, and the colours: Midnight (the default), Nord or Graphite. The choice is kept in a cookie (`hm-theme`) in that browser. The rendered view keeps its own light header, so screenshots look the same whoever takes them.

## Simple list: `GET <base>/emails`

A plain array for scripts and small tools: newest last (the newest `limit` matches, default 50), so take the last element. Fields `from`, `to`, `subject`, `body`, `raw`, `timestamp`, plus `id`, `header_to`, `codes`, `links`, `auth`. Same filters as `/api/emails`, with the same exact, case-insensitive `to`. `raw` (full MIME as text) is included when `to` is set, or with `raw=1`, up to 1 MB per response, newest first; rows past that get `raw_truncated: true` instead (fetch those from `/api/emails/:id/raw`). `raw=0` omits it. With `to` set, `body` is parsed text (see `TO_READ_PARSE_MAX` above). A bad key gets a plain `403`.

## Abuse limits

- Messages over `MAX_MESSAGE_KB` (default 4096) are stored truncated.
- The store cap (`MAX_STORE_MB`, default 350) is enforced on every arrival, counting every stored byte. Above it, unread mail is evicted first, oldest first; read mail goes only after that. A message counts as read once it is returned by `/api/wait`, or by a list with `to` or `to_prefix` (`/api/emails`, `/emails`), or opened on its own (`/api/emails/:id` or in the inbox). Searches without `to` and the inbox list do not mark mail read.
- Header fields are cut to 2,048 characters, links to the first 32 KB of the list, attachment lists to 100 entries, before storing.
- Failed logins and API calls with a bad key are logged (`auth_fail` in Workers Logs). There is no rate limiting on `workers.dev`; to add it, serve HuntMail on your own hostname and add a Cloudflare rate-limiting rule for `<base>/login` and `<base>/api/*` ([how](SETUP.md#your-own-hostname-and-rate-limiting)).
- The API key must be at least 32 characters; the Worker refuses shorter keys.
