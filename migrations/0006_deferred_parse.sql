-- Mail over 64 KB is parsed when read, not in the background: it waits as 'deferred' until a
-- read parses it. Move big mail already queued over, releasing the parse reserve it held
-- (MIN(raw_size, 100000) + 65536, see parseReserve); the parse claim adds it back.
UPDATE messages
SET parse_status = 'deferred',
    stored_size = stored_size - (MIN(raw_size, 100000) + 65536)
WHERE parse_status = 'pending' AND raw_size > 65536 AND parse_attempts = 0;
