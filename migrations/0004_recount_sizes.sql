-- Recount stored_size for every row from the bytes actually stored, with the same formula the
-- code uses on insert and parse: field bytes + raw chunks + 256 bytes of row overhead, plus the
-- parse reserve (MIN(raw_size, 100000) + 65536) while a message is still pending, so the
-- counter is exact for every existing row.
-- The messages_bytes_update trigger moves meta.stored_bytes by each row's difference.
UPDATE messages SET stored_size =
  256
  + length(CAST(envelope_to AS BLOB)) + length(CAST(envelope_from AS BLOB))
  + length(CAST(header_from AS BLOB)) + length(CAST(header_to AS BLOB))
  + length(CAST(subject AS BLOB)) + length(CAST(message_id AS BLOB)) + length(CAST(sent_at AS BLOB))
  + length(CAST(codes AS BLOB)) + length(CAST(verified_domains AS BLOB))
  + length(CAST(COALESCE(text, '') AS BLOB)) + length(CAST(links AS BLOB)) + length(CAST(attachments AS BLOB))
  + (SELECT COALESCE(SUM(length(data)), 0) FROM raw_chunks c WHERE c.message_id = messages.id)
  + CASE WHEN parse_status = 'pending' THEN MIN(raw_size, 100000) + 65536 ELSE 0 END;
