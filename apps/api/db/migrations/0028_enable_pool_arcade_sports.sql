-- Pool for the Phase 4 word, arcade and sports games that were played through settlement (ADR-041):
-- Anagrams, Filler, Tanks, Mini Golf, Darts (501 only: Around the clock stays free), Basketball, Archery and
-- 8 Ball. Word Tiles is NOT here (its word list, ADR-041). Proven in `db/tests/pool-async-games.test.ts`.
UPDATE games SET supports_pool = true
 WHERE slug IN ('anagrams', 'filler', 'tanks', 'mini-golf', 'darts', 'basketball', 'archery', 'eight-ball')
   AND enabled;
