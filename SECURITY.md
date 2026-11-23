# Security

## Reporting a vulnerability

Use the repository's private security advisory ("Report a vulnerability"
under the Security tab). Please don't open a public issue for a
vulnerability.

Describe the problem with HuntMail itself, with steps to reproduce it on a
fresh deployment. Use made-up data only: never send

- your `HUNTMAIL_URL`, API key, base path or Cloudflare token;
- real mail from your inbox, or exports of its database;
- details of a vulnerability you reported to a bug bounty program.

You'll get an answer within a week. Fixes go into the next release, and the
advisory is published once a release with the fix is out.

## Supported versions

The latest release. Updating is `git pull`, then re-running
`scripts/setup.sh` (it keeps your key, base path and settings, and applies
new migrations).

## Security model

HuntMail holds other people's mail: verification links, password resets and
codes that log into real accounts. Its design:

- **One API key guards everything**, for the API and the inbox login. Setup
  generates a 64-hex key; shorter than 32 characters is refused.
- **Every route sits under a random base path**, and every other path returns
  a bare `404`. The path hides HuntMail from crawlers and scanners; it is not
  a password (it appears in view links you share).
- **Rendered mail runs sandboxed**: `Content-Security-Policy: sandbox` with no
  scripts, remote content off unless asked for, connection hints and refresh
  tags stripped, and only images that exist in the message served. The header
  block in a render comes from HuntMail's own record, so the mail cannot hide
  or restyle it.
- **Sender checks fail closed.** Verdicts come only from the Authentication-Results
  header Cloudflare adds; anything a sender could have shaped is rejected.
- **Floods can't push out mail you've read**: unread mail is evicted first,
  and every stored byte counts toward the cap.
- Signed view links expire (15 minutes by default). Failed logins and bad keys
  are logged as `auth_fail`. Rate limiting is a Cloudflare rule on your own
  hostname ([docs/SETUP.md](docs/SETUP.md#your-own-hostname-and-rate-limiting)).

In scope: anything that lets a sender, a link or a rendered message run code,
read other mail, forge a verified sender, hide from the size cap or reach the
API without the key; and secrets or mail content leaking into logs or
responses. Out of scope: anyone holding the API key can read all mail (that
is the key's purpose), and the base path being visible in shared view links.
