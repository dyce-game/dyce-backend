-- Block and report.
--
-- Reports get a fixed set of reasons (the app's Report screen), a snapshot of the conversation at the time
-- ("evidence": a moderator must see what the reporter saw, even if messages are later deleted), a length
-- limit on the note, and indexes for the moderation queue and the per-day limit.

ALTER TABLE reports
  ADD CONSTRAINT reports_reason_chk CHECK (reason IN ('cheat', 'abuse', 'scam', 'spam', 'name', 'other')),
  ADD CONSTRAINT reports_note_len_chk CHECK (note IS NULL OR char_length(note) <= 500);
ALTER TABLE reports ADD COLUMN evidence jsonb;

CREATE INDEX reports_reporter_idx ON reports (reporter_id, created_at DESC);
CREATE INDEX reports_target_idx ON reports (target_user_id, status);
-- "who blocked me" lookups (every list and send checks both directions)
CREATE INDEX blocks_blocked_idx ON blocks (blocked_id);

INSERT INTO app_config (key, value) VALUES ('reports_per_day', '20') ON CONFLICT (key) DO NOTHING;
