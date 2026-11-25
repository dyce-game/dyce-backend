-- The Ludo room: Ludo for 3 or 4 people at a table in a Space (ADR-043).
--
-- `games.sync` is per slug, and the 2-player Ludo is the async match in a chat (`ludo`, 0020). So the live table is its
-- own row, `ludo-room`, with the live registry entry of the same name in `packages/games/src/live.ts` (the same
-- Ludo engine, 3 to 4 seats, a turn clock, `ludoAutoAction` for a seat that leaves or runs out of time). It is
-- not in the async registry, so it never shows in the chat's Games drawer: it is made from Create a space.
-- Pool is on: a Pool table of 3 and of 4 was played through settlement in a real room
-- (apps/game-server/test/ludo-room.test.ts). Pool minimum ₦500 as for the async game (docs/GAMES.md).
INSERT INTO games (slug, name, dimension, sync, min_players, max_players, categories, supports_pool, enabled,
                   pool_min_stake_kobo)
VALUES ('ludo-room', 'Ludo room', '3d', 'live', 3, 4, '{board,spaces}', true, true, 50000)
ON CONFLICT (slug) DO NOTHING;
