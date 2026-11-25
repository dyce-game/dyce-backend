-- Per-match options and the Pool clock for async matches (ADR-041).
--
-- 1. `matches.options`: the variant a sender picked when the game was sent ("Mancala" on the Ayo board, Darts'
--    Around the clock, Sea Battle salvo). Only keys and values the game's registry entry offers are ever stored
--    (the service validates them and a dry run of the engine's `init`); `{}` means the game's default rules.
-- 2. `pool_turn_hours`: how long the player(s) to move have in a Pool match before they forfeit (SPEC section 9:
--    "abandons a running match past the turn timer: forfeit"). The clock is `matches.turn_deadline`, which the
--    match service sets on accept and after every move (Pool only) and clears when the match ends.

ALTER TABLE matches
  ADD COLUMN options jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(options) = 'object');

INSERT INTO app_config (key, value) VALUES ('pool_turn_hours', '24')
ON CONFLICT (key) DO NOTHING;

-- The sweep looks for running Pool matches whose clock has run out.
CREATE INDEX matches_pool_clock_idx ON matches (turn_deadline)
  WHERE status = 'active' AND mode = 'pool' AND turn_deadline IS NOT NULL;
