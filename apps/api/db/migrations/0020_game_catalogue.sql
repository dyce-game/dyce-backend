-- The Phase 4 catalogue: every remaining async game gets its `games` row (docs/GAMES.md), and every game
-- gets its Pool minimum stake.
--
-- The new rows are DISABLED. A game becomes enabled (and appears in GET /games) when its board ships: the
-- renderer's own migration, `NNNN_enable_<slug>.sql`, flips `enabled` (and `supports_pool` once a Pool match
-- has been played through) for that slug only. See ../../../Dyce/docs/ADDING_A_GAME.md. The registry entry
-- in apps/api/src/matches/engines.ts is the other half: a row without an entry is never offered either.
--
-- Async matches are played from a one-to-one chat, so the engine is initialised with two players. The
-- player counts on a row are the catalogue's (Word Tiles and Mini Golf 2-4, for rooms and groups later).
-- Ludo is async for two players here; the 3-4 player live room is a backlog item (it needs its own slug
-- because `games.sync` is per slug).

-- ---- Pool minimum stake -------------------------------------------------------------------------------
-- In kobo; NULL means only the platform minimum (`pool_min_stake_kobo` in app_config) applies. The match
-- service uses the higher of the two when a stake is offered or countered.
ALTER TABLE games
  ADD COLUMN pool_min_stake_kobo bigint CHECK (pool_min_stake_kobo IS NULL OR pool_min_stake_kobo > 0);

-- ---- the new rows -------------------------------------------------------------------------------------
INSERT INTO games (slug, name, dimension, sync, min_players, max_players, categories, supports_pool, enabled)
VALUES
  ('eight-ball',     '8 Ball',        '3d', 'async', 2, 2, '{sports}',      false, false),
  ('darts',          'Darts',         '3d', 'async', 2, 2, '{sports}',      false, false),
  ('basketball',     'Basketball',    '3d', 'async', 2, 2, '{sports}',      false, false),
  ('archery',        'Archery',       '3d', 'async', 2, 2, '{sports}',      false, false),
  ('mini-golf',      'Mini Golf',     '2d', 'async', 2, 4, '{sports}',      false, false),
  ('tanks',          'Tanks',         '2d', 'async', 2, 2, '{arcade}',      false, false),
  ('sea-battle',     'Sea Battle',    '3d', 'async', 2, 2, '{board}',       false, false),
  ('chess',          'Chess',         '2d', 'async', 2, 2, '{board}',       false, false),
  ('checkers',       'Checkers',      '2d', 'async', 2, 2, '{board}',       false, false),
  ('ayo',            'Ayo',           '3d', 'async', 2, 2, '{board}',       false, false),
  ('ludo',           'Ludo',          '3d', 'async', 2, 2, '{board}',       false, false),
  ('dots-and-boxes', 'Dots & Boxes',  '2d', 'async', 2, 2, '{board}',       false, false),
  ('word-tiles',     'Word Tiles',    '2d', 'async', 2, 4, '{word,board}',  false, false),
  ('anagrams',       'Anagrams',      '2d', 'async', 2, 2, '{word}',        false, false),
  ('filler',         'Filler',        '2d', 'async', 2, 2, '{arcade}',      false, false)
ON CONFLICT (slug) DO NOTHING;

-- ---- Pool minimums from docs/GAMES.md (all 23 games; Pig, the reference game, has none) --------------------
UPDATE games SET pool_min_stake_kobo = v.kobo
  FROM (VALUES
    ('cup-pong',       10000),
    ('eight-ball',     20000),
    ('darts',          20000),
    ('basketball',     20000),
    ('archery',        10000),
    ('mini-golf',      10000),
    ('tanks',          10000),
    ('sea-battle',     50000),
    ('chess',          50000),
    ('checkers',       20000),
    ('ayo',            20000),
    ('ludo',           50000),
    ('dots-and-boxes', 10000),
    ('word-tiles',     20000),
    ('word-hunt',      20000),
    ('anagrams',       10000),
    ('filler',         10000),
    ('crazy-cards',    20000),
    ('whot',           20000),
    ('charades',       20000),
    ('imposter',       30000),
    ('werewolf',       50000),
    ('doodle-guess',   10000)
  ) AS v(slug, kobo)
 WHERE games.slug = v.slug;
