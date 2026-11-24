-- Pool for Word Hunt and Cup Pong, the two Phase 2 games (ADR-041).
--
-- Each was played through settlement in `db/tests/pool-async-games.test.ts` on real PostgreSQL (a full Pool match
-- to the engine's own result, a resignation, and the 24 hour turn clock, with `ledger_check_invariants` clean after
-- each). The Pool minimums are already on the rows (0020: Word Hunt ₦200, Cup Pong ₦100, from docs/GAMES.md).
UPDATE games SET supports_pool = true WHERE slug IN ('word-hunt', 'cup-pong') AND enabled;
