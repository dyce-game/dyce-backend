-- SMS invites and the guest web game (docs/DECISIONS.md ADR-021).
--
-- `sms_invites` (0002) already holds token, hashed phone and status. This adds the lifetime, the moments the
-- status changed, who joined, and the guest's browser run. The invitee's number is never stored: only
-- `phone_hash` (HMAC with PHONE_HASH_SALT, the same hash as users.phone_hash, so joining is a plain equality).

ALTER TABLE sms_invites
  ADD COLUMN expires_at      timestamptz NOT NULL DEFAULT now() + interval '7 days',
  ADD COLUMN opened_at       timestamptz,
  ADD COLUMN played_at       timestamptz,
  ADD COLUMN joined_at       timestamptz,
  ADD COLUMN joined_user_id  uuid REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE sms_invites ALTER COLUMN expires_at DROP DEFAULT;
ALTER TABLE sms_invites
  ADD CONSTRAINT sms_invites_game_fk  FOREIGN KEY (game_slug) REFERENCES games(slug),
  ADD CONSTRAINT sms_invites_match_fk FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE SET NULL;

-- Joining looks invites up by the new user's phone hash; the per-number daily limit counts by it too.
CREATE INDEX sms_invites_phone_idx ON sms_invites (phone_hash, created_at DESC);

-- One browser run per invite. `state` is the engine's full state (hidden grid included), only ever sent to the
-- browser through the engine's view(). `token_hash` is SHA-256 of the guest token (256 random bits).
CREATE TABLE guest_runs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id      uuid NOT NULL UNIQUE REFERENCES sms_invites(id) ON DELETE CASCADE,
  token_hash     bytea NOT NULL UNIQUE,
  game_slug      text NOT NULL REFERENCES games(slug),
  seed           bigint NOT NULL,
  state          jsonb NOT NULL,
  -- [{ "action": ..., "at": "<iso time>" }] in the order they were accepted; replayed when the guest signs up.
  moves          jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_state      text NOT NULL DEFAULT 'idle' CHECK (run_state IN ('idle', 'playing', 'done')),
  expires_at     timestamptz NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  finished_at    timestamptz
);

GRANT SELECT, INSERT, UPDATE, DELETE ON guest_runs TO dyce_api;

INSERT INTO app_config (key, value) VALUES
  ('invite_ttl_days',                '7'),
  ('sms_invites_per_number_per_day', '3')
ON CONFLICT (key) DO NOTHING;
