-- Sender verdicts from Cloudflare's Authentication-Results, read tracking for eviction order,
-- truncation flag, and a running stored-bytes total so the size cap can be enforced per insert.
ALTER TABLE messages ADD COLUMN auth_spf TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN auth_dkim TEXT NOT NULL DEFAULT '';
ALTER TABLE messages ADD COLUMN auth_dmarc TEXT NOT NULL DEFAULT '';
-- Comma-wrapped list (",a.com,b.net,") of domains with a passing DKIM signature or DMARC pass.
ALTER TABLE messages ADD COLUMN verified_domains TEXT NOT NULL DEFAULT ',';
ALTER TABLE messages ADD COLUMN spam_score INTEGER;
ALTER TABLE messages ADD COLUMN raw_truncated INTEGER NOT NULL DEFAULT 0;
-- First time an API or UI read returned this message. Unread mail is evicted first under pressure.
ALTER TABLE messages ADD COLUMN read_at INTEGER;

CREATE INDEX messages_evict ON messages ((read_at IS NOT NULL), received_at);

CREATE TABLE meta (k TEXT PRIMARY KEY, v INTEGER NOT NULL);
INSERT INTO meta (k, v) VALUES ('stored_bytes', (SELECT COALESCE(SUM(stored_size), 0) FROM messages));
INSERT INTO meta (k, v) VALUES ('store_failures', 0);
INSERT INTO meta (k, v) VALUES ('last_store_failure', 0);

CREATE TRIGGER messages_bytes_insert AFTER INSERT ON messages BEGIN
  UPDATE meta SET v = v + NEW.stored_size WHERE k = 'stored_bytes';
END;
CREATE TRIGGER messages_bytes_delete AFTER DELETE ON messages BEGIN
  UPDATE meta SET v = v - OLD.stored_size WHERE k = 'stored_bytes';
END;
CREATE TRIGGER messages_bytes_update AFTER UPDATE OF stored_size ON messages BEGIN
  UPDATE meta SET v = v + NEW.stored_size - OLD.stored_size WHERE k = 'stored_bytes';
END;
