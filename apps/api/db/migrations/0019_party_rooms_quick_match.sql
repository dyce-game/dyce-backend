-- Party games, Crazy Cards and quick match (ADR-025).
--
-- 1. The five new live games get their `games` rows (the registry in packages/games/src/live.ts is the
--    other half: the API refuses a space for a game that has no entry there).
-- 2. A party room applies the clock's ticks itself: a move row for a tick has no player.
-- 3. Spaces carry the host's per-game options and know when quick match opened them.
-- 4. Quick match: tickets (the queue) and its config.

-- ---- games ---------------------------------------------------------------------------------------
INSERT INTO games (slug, name, dimension, sync, min_players, max_players, categories, supports_pool, enabled)
VALUES
  ('crazy-cards',  'Crazy Cards',  '3d', 'live', 2, 4,  '{cards,spaces}',       true, true),
  ('imposter',     'Imposter',     '3d', 'live', 4, 10, '{party,spaces}',       true, true),
  ('werewolf',     'Werewolf',     '3d', 'live', 5, 12, '{party,spaces}',       true, true),
  ('charades',     'Charades',     '3d', 'live', 3, 10, '{party,spaces}',       true, true),
  ('doodle-guess', 'Doodle Guess', '2d', 'live', 3, 8,  '{party,word,spaces}',  true, true)
ON CONFLICT (slug) DO UPDATE
  SET name = EXCLUDED.name, dimension = EXCLUDED.dimension, sync = 'live',
      min_players = EXCLUDED.min_players, max_players = EXCLUDED.max_players,
      categories = EXCLUDED.categories, supports_pool = true, enabled = true;

-- ---- moves the room itself applied --------------------------------------------------------------
-- A party engine counts its phase timers down on `{ kind: 'tick', ms }` actions the room sends. The ones
-- that change something (a phase ended, a silent seat was filled in) are logged like any move, with no
-- player; the ones that only move a clock are not logged at all.
ALTER TABLE match_moves ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE match_moves
  ADD CONSTRAINT match_moves_actor_ck CHECK (user_id IS NOT NULL OR action ->> 'kind' = 'tick');

-- ---- spaces --------------------------------------------------------------------------------------
ALTER TABLE spaces
  ADD COLUMN options jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN quick_match boolean NOT NULL DEFAULT false;
CREATE INDEX spaces_quick_started_idx ON spaces (started_at DESC) WHERE quick_match;

-- A space that quick match opens starts at once for people who have just accepted: no "space starting"
-- push for the second person.
CREATE OR REPLACE FUNCTION _trg_space_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_name text;
  m record;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'live' AND OLD.status = 'waiting' THEN
    IF NEW.quick_match THEN RETURN NEW; END IF;
    SELECT name INTO v_name FROM games WHERE slug = NEW.game_slug;
    FOR m IN SELECT user_id FROM space_members
              WHERE space_id = NEW.id AND left_at IS NULL AND NOT removed AND user_id <> NEW.host_id LOOP
      PERFORM _notify(m.user_id, 'space_starting', NEW.host_id,
                      jsonb_build_object('spaceId', NEW.id, 'code', NEW.code, 'name', NEW.name,
                                         'gameSlug', NEW.game_slug, 'gameName', v_name, 'mode', NEW.mode,
                                         'seatFeeKobo', NEW.seat_fee_kobo),
                      'space:' || NEW.id);
    END LOOP;
  ELSIF NEW.status IN ('ended', 'closed') THEN
    UPDATE notifications SET read_at = now() WHERE dedupe_key = 'space:' || NEW.id AND read_at IS NULL;
  END IF;
  RETURN NEW;
END;
$$;

-- ---- quick match ---------------------------------------------------------------------------------
-- One row per search. `searching` = in the queue. `found` = paired with another ticket in a waiting
-- two-seat space (Pool stakes are escrowed at this moment) and both have until `accept_by` to accept.
-- `playing` = both accepted and the space started. Everything else is an end state; a person whose
-- opponent declined or missed goes back to `searching` (same row, same priority).
CREATE TABLE quick_match_tickets (
  id                  uuid PRIMARY KEY,
  user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  game_slug           text NOT NULL REFERENCES games(slug),
  mode                match_mode NOT NULL,
  stake_kobo          bigint NOT NULL DEFAULT 0 CHECK (stake_kobo >= 0),
  -- level when the search began: the gap rule compares these
  level               int NOT NULL CHECK (level >= 1),
  status              text NOT NULL CHECK (status IN
                        ('searching', 'found', 'playing', 'cancelled', 'expired', 'declined', 'missed', 'failed')),
  space_id            uuid REFERENCES spaces(id) ON DELETE SET NULL,
  opponent_ticket_id  uuid,
  found_at            timestamptz,
  accept_by           timestamptz,
  accepted_at         timestamptz,
  error_code          text,
  search_ends_at      timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (mode = 'pool' OR stake_kobo = 0)
);
-- A person has at most one search going.
CREATE UNIQUE INDEX quick_match_one_open_idx ON quick_match_tickets (user_id)
  WHERE status IN ('searching', 'found');
CREATE INDEX quick_match_queue_idx ON quick_match_tickets (game_slug, mode, stake_kobo, created_at)
  WHERE status = 'searching';
CREATE INDEX quick_match_found_idx ON quick_match_tickets (accept_by) WHERE status = 'found';
CREATE INDEX quick_match_user_idx ON quick_match_tickets (user_id, created_at DESC);

GRANT SELECT, INSERT, UPDATE, DELETE ON quick_match_tickets TO dyce_api;

INSERT INTO app_config (key, value) VALUES
  ('quick_match_search_seconds', '60'),
  ('quick_match_level_gap', '3'),
  ('quick_match_widen_seconds', '15'),
  ('quick_match_accept_seconds', '10'),
  ('quick_match_accept_grace_seconds', '3'),
  ('quick_match_per_hour', '30'),
  ('quick_match_miss_limit', '3'),
  ('quick_match_rematch_minutes', '10')
ON CONFLICT (key) DO NOTHING;
