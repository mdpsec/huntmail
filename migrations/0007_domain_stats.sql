-- Per-domain daily tally for the stats page ("which domain gets the most mail"), bumped by a
-- trigger as each message is stored: one extra row write per message, no table scans to read.
-- Kept as long as daily_stats (pruned after a year by the retention run).
CREATE TABLE domain_daily (
  day      TEXT NOT NULL,              -- UTC date, YYYY-MM-DD
  domain   TEXT NOT NULL,              -- recipient domain (envelope_to is stored lowercased)
  received INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, domain)
) WITHOUT ROWID;
INSERT INTO domain_daily (day, domain, received)
  SELECT strftime('%Y-%m-%d', received_at / 1000, 'unixepoch'), substr(envelope_to, instr(envelope_to, '@') + 1), COUNT(*)
  FROM messages GROUP BY 1, 2;

CREATE TRIGGER messages_domain_insert AFTER INSERT ON messages BEGIN
  INSERT INTO domain_daily (day, domain, received)
    VALUES (strftime('%Y-%m-%d', NEW.received_at / 1000, 'unixepoch'), substr(NEW.envelope_to, instr(NEW.envelope_to, '@') + 1), 1)
    ON CONFLICT (day, domain) DO UPDATE SET received = received + 1;
END;
