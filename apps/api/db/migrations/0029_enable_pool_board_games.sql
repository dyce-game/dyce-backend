-- Pool for the Phase 4 board games that were played through settlement (ADR-041): Chess, Checkers, Ayo (and its
-- Mancala mode), Dots & Boxes, Ludo (two players) and Sea Battle (classic and salvo). Proven in
-- `db/tests/pool-async-games.test.ts`.
UPDATE games SET supports_pool = true
 WHERE slug IN ('chess', 'checkers', 'ayo', 'dots-and-boxes', 'ludo', 'sea-battle')
   AND enabled;
