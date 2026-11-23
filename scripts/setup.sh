#!/usr/bin/env bash
# One-shot setup: D1 database, migrations, Worker deploy, API key and base path secrets, Email Routing, catch-all.
# Safe to re-run. See docs/SETUP.md for the token permissions it needs.
#
#   CLOUDFLARE_API_TOKEN=... ./scripts/setup.sh --domain example.com [--name huntmail] [--account <id>] [--force]
#
# --force replaces an existing catch-all rule that does something other than drop mail.
set -euo pipefail

NAME="huntmail"
DOMAIN=""
ACCOUNT_ID="${CLOUDFLARE_ACCOUNT_ID:-}"
FORCE=0
while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --account) ACCOUNT_ID="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) sed -n 2,8p "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "error: $*" >&2; exit 1; }
step() { echo "==> $*"; }
[ -n "${CLOUDFLARE_API_TOKEN:-}" ] || die "set CLOUDFLARE_API_TOKEN"
[ -n "$DOMAIN" ] || die "pass --domain"
[[ "$NAME" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "--name must be lowercase letters, digits and dashes"
for bin in curl jq npx openssl; do command -v "$bin" >/dev/null || die "$bin is required"; done

cd "$(dirname "$0")/.."
API="https://api.cloudflare.com/client/v4"

# cf METHOD PATH [JSON]: prints .result, dies with Cloudflare's error message on failure.
# The token and request bodies never appear on a command line (other local users can read those
# with ps): the auth header comes from a file descriptor, the body from stdin.
cf() {
  local method="$1" path="$2" body="${3:-}" out
  if [ -n "$body" ]; then
    out=$(printf '%s' "$body" | curl -sS -X "$method" "$API$path" -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN") -H "Content-Type: application/json" --data-binary @-)
  else
    out=$(curl -sS -X "$method" "$API$path" -H @<(printf 'Authorization: Bearer %s\n' "$CLOUDFLARE_API_TOKEN"))
  fi
  if [ "$(jq -r '.success' <<<"$out")" != "true" ]; then
    echo "Cloudflare API $method $path failed:" >&2
    jq -c '.errors' <<<"$out" >&2
    return 1
  fi
  jq -c '.result' <<<"$out"
}

step "Checking token"
cf GET /user/tokens/verify >/dev/null || die "token is not valid"

step "Finding zone $DOMAIN"
ZONE=$(cf GET "/zones?name=$DOMAIN") || die "cannot list zones; does the token include Zone permissions for $DOMAIN?"
ZONE_ID=$(jq -r '.[0].id // empty' <<<"$ZONE")
[ -n "$ZONE_ID" ] || die "zone $DOMAIN not found. Add the domain to Cloudflare first and include it in the token's zone resources."
[ -n "$ACCOUNT_ID" ] || ACCOUNT_ID=$(jq -r '.[0].account.id' <<<"$ZONE")
export CLOUDFLARE_ACCOUNT_ID="$ACCOUNT_ID"

step "D1 database $NAME"
DB_ID=$(cf GET "/accounts/$ACCOUNT_ID/d1/database?name=$NAME" | jq -r --arg n "$NAME" '.[] | select(.name == $n) | .uuid' | head -1)
if [ -z "$DB_ID" ]; then
  DB_ID=$(cf POST "/accounts/$ACCOUNT_ID/d1/database" "$(jq -nc --arg n "$NAME" '{name: $n}')" | jq -r '.uuid')
  echo "    created $DB_ID"
else
  echo "    exists $DB_ID"
fi

step "Writing wrangler.local.jsonc"
# Strip // comments from the template, then set name and database id. On a re-run, settings
# already in wrangler.local.jsonc (vars, routes, workers_dev) are kept; new template vars are added.
strip_comments() { sed -E 's#^[[:space:]]*//.*$##; s#[[:space:]]//[^"]*$##' "$1"; }
PREV='{}'
if [ -f wrangler.local.jsonc ]; then
  PREV=$(strip_comments wrangler.local.jsonc | jq -c '{vars, routes, workers_dev} | with_entries(select(.value != null))') \
    || die "wrangler.local.jsonc exists but could not be read; fix or move it, then re-run"
  echo "    keeping settings from the existing wrangler.local.jsonc"
fi
strip_comments wrangler.jsonc \
  | jq --arg n "$NAME" --arg db "$DB_ID" --arg d "$DOMAIN" --argjson prev "$PREV" '
      .name = $n | .d1_databases[0].database_name = $n | .d1_databases[0].database_id = $db
      | ."$schema" = "node_modules/wrangler/config-schema.json"
      | .vars = (.vars + ($prev.vars // {}))
      | .vars.DOMAINS = ((.vars.DOMAINS // "") | split(",") | map(gsub("^\\s+|\\s+$"; "") | ascii_downcase) | . + [$d | ascii_downcase] | map(select(. != "")) | unique | join(","))
      | if $prev.routes then .routes = $prev.routes else . end
      | if $prev | has("workers_dev") then .workers_dev = $prev.workers_dev else . end' \
  > wrangler.local.jsonc.tmp
mv wrangler.local.jsonc.tmp wrangler.local.jsonc

step "Applying migrations"
npx --no-install wrangler d1 migrations apply DB --remote --config wrangler.local.jsonc

step "Deploying Worker $NAME"
npx --no-install wrangler deploy --config wrangler.local.jsonc

# The Worker exists now (deployed above), so listing its secrets must work. If it does not, stop:
# carrying on would generate and overwrite the existing API key and base path.
SECRETS=$(cf GET "/accounts/$ACCOUNT_ID/workers/scripts/$NAME/secrets") \
  || die "cannot list the Worker's secrets; not touching the API key or base path"
has_secret() { jq -e --arg n "$1" '.[] | select(.name == $n)' <<<"$SECRETS" >/dev/null; }
# Direct API call: no trailing newline from stdin can end up in the secret. The value reaches jq
# through the environment, not its arguments.
put_secret() { cf PUT "/accounts/$ACCOUNT_ID/workers/scripts/$NAME/secrets" "$(SECRET_NAME="$1" SECRET_VALUE="$2" jq -nc '{name: env.SECRET_NAME, text: env.SECRET_VALUE, type: "secret_text"}')" >/dev/null; }

step "API key secret"
if [ -n "${HUNTMAIL_API_KEY:-}" ]; then
  # The Worker refuses keys under 32 characters; generate with: openssl rand -hex 32
  [ "${#HUNTMAIL_API_KEY}" -ge 32 ] || die "HUNTMAIL_API_KEY must be at least 32 characters (openssl rand -hex 32)"
  KEY="$HUNTMAIL_API_KEY"
  KEY_SOURCE="from HUNTMAIL_API_KEY"
elif has_secret API_KEY; then
  KEY=""
  KEY_SOURCE="kept existing (set HUNTMAIL_API_KEY to replace it)"
else
  KEY=$(openssl rand -hex 32)
  KEY_SOURCE="generated"
fi
[ -z "$KEY" ] || put_secret API_KEY "$KEY"
echo "    $KEY_SOURCE"

# Every route lives under https://<worker>/<BASE_PATH>/; everything else is a bare 404.
step "Private base path"
if [ -n "${HUNTMAIL_BASE_PATH:-}" ]; then
  [[ "$HUNTMAIL_BASE_PATH" =~ ^[A-Za-z0-9_-]{16,128}$ ]] || die "HUNTMAIL_BASE_PATH must be 16-128 letters, digits, - or _ (openssl rand -hex 16)"
  BASE_PATH="$HUNTMAIL_BASE_PATH"
  PATH_SOURCE="from HUNTMAIL_BASE_PATH"
elif has_secret BASE_PATH; then
  BASE_PATH=""
  PATH_SOURCE="kept existing (set HUNTMAIL_BASE_PATH to replace it)"
else
  BASE_PATH=$(openssl rand -hex 16)
  PATH_SOURCE="generated"
fi
[ -z "$BASE_PATH" ] || put_secret BASE_PATH "$BASE_PATH"
echo "    $PATH_SOURCE"

step "Email Routing on $DOMAIN"
STATUS=$(cf GET "/zones/$ZONE_ID/email/routing" | jq -r '"\(.enabled) \(.status)"')
if [ "$STATUS" != "true ready" ]; then
  cf POST "/zones/$ZONE_ID/email/routing/dns" '{}' >/dev/null \
    || die "could not enable Email Routing. Existing MX records for $DOMAIN may conflict; remove them or enable Email Routing in the dashboard."
  STATUS=$(cf GET "/zones/$ZONE_ID/email/routing" | jq -r '"\(.enabled) \(.status)"')
fi
echo "    $STATUS"

step "Catch-all rule -> Worker $NAME"
CURRENT=$(cf GET "/zones/$ZONE_ID/email/routing/rules/catch_all" || echo '{}')
CUR_TYPE=$(jq -r '.actions[0].type // "none"' <<<"$CURRENT")
CUR_VALUE=$(jq -r '.actions[0].value[0] // ""' <<<"$CURRENT")
CUR_ENABLED=$(jq -r '.enabled // false' <<<"$CURRENT")
if [ "$CUR_TYPE" = "worker" ] && [ "$CUR_VALUE" = "$NAME" ] && [ "$CUR_ENABLED" = "true" ]; then
  echo "    already set"
else
  if [ "$CUR_ENABLED" = "true" ] && [ "$CUR_TYPE" != "drop" ] && [ "$FORCE" -ne 1 ]; then
    die "catch-all currently does '$CUR_TYPE $CUR_VALUE'. Re-run with --force to replace it."
  fi
  cf PUT "/zones/$ZONE_ID/email/routing/rules/catch_all" \
    "$(jq -nc --arg n "$NAME" '{name: "huntmail catch-all", enabled: true, matchers: [{type: "all"}], actions: [{type: "worker", value: [$n]}]}')" >/dev/null
  echo "    set"
fi

SUB=$(cf GET "/accounts/$ACCOUNT_ID/workers/subdomain" | jq -r '.subdomain')
ORIGIN="https://$NAME.$SUB.workers.dev"
if [ -n "$BASE_PATH" ]; then URL="$ORIGIN/$BASE_PATH"; else URL="$ORIGIN/<your base path>"; fi
echo
echo "Done."
echo "  HUNTMAIL_URL: $URL"
echo "  Inbox:        $URL/inbox"
if [ -n "$KEY" ]; then
  echo "  API key:      $KEY"
fi
if [ -n "$KEY" ] || [ -n "$BASE_PATH" ]; then
  echo "  Store these now (password manager or your agent's env). They are not shown again."
fi
if [ -z "$BASE_PATH" ]; then
  echo "  The base path was kept: use the HUNTMAIL_URL you saved at first setup."
fi
echo "  The bare $ORIGIN/ returns 404 on purpose: every route is under the base path."
echo
echo "Test: send any mail to test-$(date +%s)@$DOMAIN, then:"
echo "  curl -s -H \"X-Api-Key: \$HUNTMAIL_API_KEY\" \"\$HUNTMAIL_URL/api/emails?limit=1\" | jq"
