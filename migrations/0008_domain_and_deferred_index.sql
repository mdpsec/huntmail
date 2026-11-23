-- Two lookups that would otherwise scan the table.
--
-- Mail for one recipient domain (to_domain=): an index on the part of envelope_to after the @.
-- Queries must use the same expression, substr(envelope_to, instr(envelope_to, '@') + 1), for
-- SQLite to pick it. One more index write per message stored or removed.
CREATE INDEX messages_to_domain_time ON messages (substr(envelope_to, instr(envelope_to, '@') + 1), received_at);

-- Deferred (big) mail, newest first, for the optional background parse (CRON_PARSE_DEFERRED).
-- Partial: only deferred rows are in it, so it stays small and costs a write only when a message
-- enters or leaves the deferred state.
CREATE INDEX messages_deferred ON messages (received_at) WHERE parse_status = 'deferred';
