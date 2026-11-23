-- Messages and their gzip-compressed raw MIME, split into chunks to stay under D1's 2 MB row limit.
CREATE TABLE messages (
  id            TEXT PRIMARY KEY,
  received_at   INTEGER NOT NULL,          -- unix ms
  envelope_to   TEXT NOT NULL,             -- lowercased RCPT TO
  envelope_from TEXT NOT NULL,
  header_from   TEXT NOT NULL DEFAULT '',
  header_to     TEXT NOT NULL DEFAULT '',
  subject       TEXT NOT NULL DEFAULT '',
  message_id    TEXT NOT NULL DEFAULT '',
  sent_at       TEXT NOT NULL DEFAULT '',  -- Date header as sent
  text          TEXT NOT NULL DEFAULT '',  -- plain text body, truncated
  has_html      INTEGER NOT NULL DEFAULT 0,
  codes         TEXT NOT NULL DEFAULT '[]',
  links         TEXT NOT NULL DEFAULT '[]',
  attachments   TEXT NOT NULL DEFAULT '[]',
  raw_size      INTEGER NOT NULL,
  stored_size   INTEGER NOT NULL,          -- bytes this row and its chunks hold
  compressed    INTEGER NOT NULL,          -- 1 when chunks are gzip
  chunk_count   INTEGER NOT NULL,
  parse_status  TEXT NOT NULL DEFAULT 'pending', -- pending | ok | partial | failed
  parse_attempts INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX messages_to_time ON messages (envelope_to, received_at);
CREATE INDEX messages_time ON messages (received_at);
CREATE INDEX messages_pending ON messages (parse_status, received_at) WHERE parse_status = 'pending';

CREATE TABLE raw_chunks (
  message_id TEXT NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  seq        INTEGER NOT NULL,
  data       BLOB NOT NULL,
  PRIMARY KEY (message_id, seq)
);
