-- Newsletters and blocks.
--
-- bulk: set at arrival when the mail has newsletter headers (List-Unsubscribe, List-Id,
-- Precedence bulk/list/junk) and a subject that does not look like account mail.
-- has_action: set by the parse when the mail has a verify, reset, sign-in or invite link.
-- A message is a newsletter when it is bulk, parsed, and has no code and no action link; see
-- NEWSLETTER_SQL in src/store.ts, which must match the index below word for word. Mail stored
-- before this migration counts as not bulk.
ALTER TABLE messages ADD COLUMN bulk INTEGER NOT NULL DEFAULT 0;
ALTER TABLE messages ADD COLUMN has_action INTEGER NOT NULL DEFAULT 0;

-- Newsletters, oldest first: their count, eviction before other mail, and their own retention.
CREATE INDEX messages_newsletter ON messages (received_at)
  WHERE bulk = 1 AND has_action = 0 AND codes = '[]' AND parse_status IN ('ok', 'partial');

-- Mail rejected at arrival, never stored. kind: 'sender' (the From domain and its subdomains),
-- 'recipient' (one address) or 'prefix' (addresses starting with value). scope: 'newsletters'
-- (sender only: bulk mail) or 'all'.
CREATE TABLE blocks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,
  value      TEXT NOT NULL,
  scope      TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  hits       INTEGER NOT NULL DEFAULT 0,
  last_hit   INTEGER,
  UNIQUE (kind, value)
);
