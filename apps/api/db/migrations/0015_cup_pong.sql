-- Cup Pong: the first 3D game on the async match platform (docs/ADDING_A_GAME.md).
--
-- Two players, ten cups each, three balls a turn; the client sends only {aim, power} and the server
-- re-simulates the throw (packages/games/src/cuppong, ADR-013). One player moves at a time, so it needs
-- nothing from the match service beyond the registry entry in apps/api/src/matches/engines.ts.
--
-- Free only for now: supports_pool stays false until a Pool Cup Pong has been played through settlement
-- (a later migration flips it).
INSERT INTO games (slug, name, dimension, sync, min_players, max_players, categories, supports_pool, enabled)
VALUES ('cup-pong', 'Cup Pong', '3d', 'async', 2, 2, '{sports}', false, true)
ON CONFLICT (slug) DO NOTHING;
