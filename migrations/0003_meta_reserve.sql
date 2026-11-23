-- The parse reserve now also covers the links and attachment lists (META_RESERVE, 64 KiB).
-- Messages still pending get it added, so the parse that swaps reserve for real bytes stays exact.
-- The messages_bytes_update trigger moves meta.stored_bytes by the same amount.
UPDATE messages SET stored_size = stored_size + 65536 WHERE parse_status = 'pending';
