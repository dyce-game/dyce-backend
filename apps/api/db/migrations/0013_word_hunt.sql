-- Word Hunt: the first real game on the async match platform (docs/ADDING_A_GAME.md).
--
-- 4x4 grid, 80 second round, both players play the same seeded grid on their own time. The engine is in
-- packages/games/src/wordhunt; the clock rule (a submit later than the round plus a grace period scores
-- nothing) lives in apps/api/src/matches/engines.ts because engines have no clock.
--
-- Free only for now: supports_pool stays false until Pool settlement has been checked against a game where
-- both players act at once (a later migration flips it).
INSERT INTO games (slug, name, dimension, sync, min_players, max_players, categories, supports_pool, enabled)
VALUES ('word-hunt', 'Word Hunt', '2d', 'async', 2, 2, '{word}', false, true)
ON CONFLICT (slug) DO NOTHING;
