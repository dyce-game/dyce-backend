-- Async matches in a chat (Free mode first).
--
-- A match is invited by one player in a direct conversation, accepted by the other, then played move by
-- move. `matches.state` holds the engine's full state (including hidden information and RNG state): it is
-- only ever sent to a client through the engine's view(). The chat card is a `messages` row of kind 'game'
-- whose id is the match id.

ALTER TABLE matches ADD COLUMN invite_expires_at timestamptz;

CREATE INDEX match_players_user_idx ON match_players (user_id);
CREATE INDEX matches_open_invites_idx ON matches (conversation_id, created_by) WHERE status = 'invited';

-- Pig is the reference engine (packages/games/src/_example). The API lists and accepts it only outside
-- production, so this row is inert there.
INSERT INTO games (slug, name, dimension, sync, min_players, max_players, categories, supports_pool, enabled)
VALUES ('_example', 'Pig', '2d', 'async', 2, 2, '{arcade}', false, true)
ON CONFLICT (slug) DO NOTHING;

INSERT INTO app_config (key, value) VALUES ('open_match_invites_per_chat', '5')
ON CONFLICT (key) DO NOTHING;
