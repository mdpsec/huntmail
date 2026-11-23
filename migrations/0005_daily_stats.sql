-- Stats page support, sized for the free plan (reads are plentiful, writes are not).

-- Per-day tally, bumped by a trigger as each message is stored: one extra row write per message.
-- It outlives the messages themselves (pruned after a year), so history stays accurate after
-- retention or the size cap removes old mail.
CREATE TABLE daily_stats (
  day       TEXT PRIMARY KEY,           -- UTC date, YYYY-MM-DD
  received  INTEGER NOT NULL DEFAULT 0, -- messages stored that day
  raw_bytes INTEGER NOT NULL DEFAULT 0  -- their original size
);
INSERT INTO daily_stats (day, received, raw_bytes)
  SELECT strftime('%Y-%m-%d', received_at / 1000, 'unixepoch'), COUNT(*), SUM(raw_size) FROM messages GROUP BY 1;

CREATE TRIGGER messages_daily_insert AFTER INSERT ON messages BEGIN
  INSERT INTO daily_stats (day, received, raw_bytes)
    VALUES (strftime('%Y-%m-%d', NEW.received_at / 1000, 'unixepoch'), 1, NEW.raw_size)
    ON CONFLICT (day) DO UPDATE SET received = received + 1, raw_bytes = raw_bytes + excluded.raw_bytes;
END;

-- Live message count, kept in the same meta row as stored_bytes so it costs no extra write:
-- counting rows on every stats view would read the whole table.
ALTER TABLE meta ADD COLUMN n INTEGER NOT NULL DEFAULT 0;
UPDATE meta SET n = (SELECT COUNT(*) FROM messages) WHERE k = 'stored_bytes';
DROP TRIGGER messages_bytes_insert;
CREATE TRIGGER messages_bytes_insert AFTER INSERT ON messages BEGIN
  UPDATE meta SET v = v + NEW.stored_size, n = n + 1 WHERE k = 'stored_bytes';
END;
DROP TRIGGER messages_bytes_delete;
CREATE TRIGGER messages_bytes_delete AFTER DELETE ON messages BEGIN
  UPDATE meta SET v = v - OLD.stored_size, n = n - 1 WHERE k = 'stored_bytes';
END;

-- Failed parses are rare; a partial index lets the stats count them without a table scan.
CREATE INDEX messages_failed ON messages (id) WHERE parse_status = 'failed';
