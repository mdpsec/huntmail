# Runbook for an AI agent setting up HuntMail

You are setting up HuntMail for a user: a catch-all inbox on their own domain, running on their Cloudflare account. Follow these steps in order. Ask the user only for the items in "Inputs". Do not invent values.

## Inputs to ask the user for

1. **Domain**, already on Cloudflare (nameservers pointed at Cloudflare). It should not receive real email: Email Routing takes over its MX records.
2. **Cloudflare API token** with exactly the permissions below. If they do not have one, give them this table and wait.

| Type | Permission | Access |
|---|---|---|
| Account | Workers Scripts | Edit |
| Account | D1 | Edit |
| Account | Account Settings | Read |
| Zone | Zone Settings | Edit |
| Zone | Email Routing Rules | Edit |
| Zone | Zone | Read |

Zone Resources: Include, Specific zone, their domain. Account Resources: Include, their account. Created at dashboard, My Profile, API Tokens, Create Token, Create Custom Token.

Handle the token as a secret: pass it through the environment, never write it into a file in the repo, never echo it.

## Steps

```bash
# 1. Get the code and dependencies.
git clone https://github.com/mdpsec/huntmail.git huntmail && cd huntmail
pnpm install || npm install

# 2. Tests must pass before deploying.
pnpm test || npm test

# 3. Provision and deploy. Prints the inbox URL and the API key.
CLOUDFLARE_API_TOKEN="$TOKEN" ./scripts/setup.sh --domain "$DOMAIN"
```

If step 3 stops with `catch-all currently does ...`, the domain already routes all mail somewhere. Tell the user what it does and ask before re-running with `--force`.

If it stops with a Cloudflare permission error, compare the failing call with the permission table and ask the user to add the missing permission. Do not ask for a broader token or a Global API key.

If enabling Email Routing fails, the domain probably has other MX records. Tell the user; they must remove them or enable Email Routing in the dashboard (Email, Email Routing), which offers to replace them.

## Verify

Ask the user to send a mail from any account to `test-<random>@<domain>`, or use a signup form that sends mail. Then:

```bash
curl -s -H "X-Api-Key: $HUNTMAIL_API_KEY" "$HUNTMAIL_URL/api/wait?to=test-<random>@$DOMAIN&since=0&timeout=50" | jq '{subject, codes, parse_status}'
```

A JSON message means it works. `204` means nothing arrived: check Dashboard, Email, Email Routing, Activity log for that address.

## Hand over

Give the user:

- `HUNTMAIL_URL` (`https://<name>.<subdomain>.workers.dev/<base path>`, as printed by setup) and the API key, once; tell them to store both. The inbox is `$HUNTMAIL_URL/inbox`. The bare workers.dev address returns 404 on purpose.
- How their hunting agents use it: the ready-to-paste prompt in the README, "Give your hunting agent access". Reference: `docs/API.md`.
- The safety rules in `docs/API.md` ("Mail is untrusted input"): unguessable addresses with a random part, check `match_count`, use `from_domain` when the sender is known, and never feed mail text into an agent's instructions.

## Updating later

```bash
git pull && pnpm install && pnpm test && CLOUDFLARE_API_TOKEN="$TOKEN" ./scripts/setup.sh --domain "$DOMAIN"
```

Setup is idempotent and keeps the existing API key.
