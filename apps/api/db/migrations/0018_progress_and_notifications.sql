-- Progress (XP, levels, streaks, badges) and notifications (ADR-023).
--
-- Both are written by the database, in the same transaction that finishes a match, accepts a friend or moves
-- money. That way every writer (the API's async matches, the Colyseus game server, the wallet functions)
-- produces them without each service having to remember, and a failed transaction produces none.
--
--   * matches -> finished        : XP, level, streak, badges (AFTER UPDATE trigger, runs first)
--   * friendships / matches / spaces / payment_requests / ledger_txns : rows in `notifications`
--   * `notifications.dispatched_at` is the push queue: the API's dispatcher sends what is still NULL.

-- ---------------------------------------------------------------------------------------------
-- config
-- ---------------------------------------------------------------------------------------------

INSERT INTO app_config (key, value) VALUES
  ('xp_games_per_day',      '30'),   -- matches that can earn XP for one person per Lagos day
  ('xp_pair_games_per_day', '5'),    -- 1v1 matches between the same two people that can earn XP per day
  ('people_searches_per_day', '600')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- progress tables
-- ---------------------------------------------------------------------------------------------

-- One XP event per (person, match, reason): a retried settle can never award twice.
CREATE UNIQUE INDEX xp_events_once_per_match ON xp_events (user_id, match_id, reason) WHERE match_id IS NOT NULL;
CREATE INDEX xp_events_created_idx ON xp_events (created_at) INCLUDE (user_id, amount, match_id);

ALTER TABLE badges
  ADD COLUMN color text NOT NULL DEFAULT '#C93E1C',
  ADD COLUMN sort  int  NOT NULL DEFAULT 100;

INSERT INTO badges (slug, name, description, icon, color, sort) VALUES
  ('first-win',   'First Win',   'Win your first game.',                           '1st', '#2BB673', 10),
  ('streak-10',   '10 Streak',   'Win on 10 days in a row.',                       '10',  '#C2410C', 20),
  ('pool-shark',  'Pool Shark',  'Win 5 Pool games.',                              '₦',   '#C93E1C', 30),
  ('space-host',  'Space Host',  'Host a Space that finishes with 4 or more players.', '4+', '#B37A00', 40),
  ('whot-master', 'Whot Master', 'Win 10 games of Whot!',                         'W',   '#7C8597', 50)
ON CONFLICT (slug) DO NOTHING;

-- Progress is only ever written by the award trigger below (SECURITY DEFINER), never by the API role.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON xp_events, streaks, user_badges FROM dyce_api;
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON badges FROM dyce_api;

-- ---------------------------------------------------------------------------------------------
-- notifications
-- ---------------------------------------------------------------------------------------------

ALTER TABLE notifications
  ADD COLUMN actor_id       uuid REFERENCES users(id) ON DELETE SET NULL,
  -- Rows with the same key are one row that is refreshed and becomes unread again ("your turn" in one match).
  ADD COLUMN dedupe_key     text,
  -- NULL = still to be handed to the push dispatcher; set once sent or deliberately skipped.
  ADD COLUMN dispatched_at  timestamptz,
  ADD COLUMN push_attempts  int NOT NULL DEFAULT 0;

-- Rows that exist before this migration (none in practice) must not be pushed.
UPDATE notifications SET dispatched_at = now();

CREATE UNIQUE INDEX notifications_dedupe_key ON notifications (user_id, dedupe_key)
  WHERE dedupe_key IS NOT NULL;
CREATE INDEX notifications_unread_idx  ON notifications (user_id) WHERE read_at IS NULL;
CREATE INDEX notifications_pending_idx ON notifications (created_at) WHERE dispatched_at IS NULL;

-- Per-person switches. `prefs` maps a group key (turns, invites, pool, money, spaces) to true/false; a missing key
-- means on. Quiet hours are minutes after midnight in the person's own clock, `tz_offset_min` being its offset
-- from UTC as the phone reports it.
CREATE TABLE notification_prefs (
  user_id        uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  prefs          jsonb NOT NULL DEFAULT '{}'::jsonb,
  quiet_enabled  boolean NOT NULL DEFAULT false,
  quiet_start    int NOT NULL DEFAULT 1320 CHECK (quiet_start BETWEEN 0 AND 1439), -- 22:00
  quiet_end      int NOT NULL DEFAULT 420  CHECK (quiet_end BETWEEN 0 AND 1439),   -- 07:00
  tz_offset_min  int NOT NULL DEFAULT 60   CHECK (tz_offset_min BETWEEN -840 AND 840),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON notification_prefs TO dyce_api;

-- A device token belongs to one person at a time: signing in as someone else on the same phone moves it.
DELETE FROM push_tokens a USING push_tokens b
 WHERE a.token = b.token AND a.updated_at < b.updated_at;
CREATE UNIQUE INDEX push_tokens_token_key ON push_tokens (token);

-- ---------------------------------------------------------------------------------------------
-- search
-- ---------------------------------------------------------------------------------------------

-- Prefix search on @username (the only way to find a stranger) and on display names.
CREATE INDEX profiles_username_prefix_idx ON profiles (lower(username) text_pattern_ops);
CREATE INDEX profiles_display_prefix_idx  ON profiles (lower(display_name) text_pattern_ops);

-- Per-person daily counter for people searches (the same idea as contact_lookups).
CREATE TABLE search_usage (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      date NOT NULL,
  n        int  NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON search_usage TO dyce_api;

-- Profile and leaderboard reads.
CREATE INDEX match_players_user_result_idx ON match_players (user_id, match_id) WHERE result IS NOT NULL;
CREATE INDEX matches_finished_idx ON matches (finished_at DESC) WHERE status = 'finished';

-- ---------------------------------------------------------------------------------------------
-- notification writers
-- ---------------------------------------------------------------------------------------------

-- The one way a notification is created. Skips: nobody, yourself, a disabled account, anyone blocked either way
-- with the person who caused it, and (when asked) anyone who is not a friend.
CREATE FUNCTION _notify(
  p_user uuid, p_kind text, p_actor uuid, p_payload jsonb,
  p_dedupe text DEFAULT NULL, p_friends_only boolean DEFAULT false
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_user IS NULL OR p_user IS NOT DISTINCT FROM p_actor THEN RETURN; END IF;
  IF EXISTS (SELECT 1 FROM users WHERE id = p_user AND disabled_at IS NOT NULL) THEN RETURN; END IF;
  IF p_actor IS NOT NULL THEN
    IF _is_blocked(p_user, p_actor) THEN RETURN; END IF;
    IF p_friends_only AND NOT EXISTS (
      SELECT 1 FROM friendships
       WHERE user_low = LEAST(p_user, p_actor) AND user_high = GREATEST(p_user, p_actor) AND status = 'accepted'
    ) THEN RETURN; END IF;
  END IF;

  INSERT INTO notifications (user_id, kind, actor_id, payload, dedupe_key)
  VALUES (p_user, p_kind, p_actor, coalesce(p_payload, '{}'::jsonb), p_dedupe)
  ON CONFLICT (user_id, dedupe_key) WHERE dedupe_key IS NOT NULL
  DO UPDATE SET created_at = now(), payload = EXCLUDED.payload, actor_id = EXCLUDED.actor_id,
                read_at = NULL, dispatched_at = NULL, push_attempts = 0;
END;
$$;

-- Friends: a request, an answer, a withdrawn request.
CREATE FUNCTION _trg_friendship_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_other uuid;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status = 'pending' THEN
      v_other := CASE WHEN NEW.requested_by = NEW.user_low THEN NEW.user_high ELSE NEW.user_low END;
      PERFORM _notify(v_other, 'friend_request', NEW.requested_by, '{}'::jsonb, 'fr:' || NEW.requested_by);
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    v_other := CASE WHEN NEW.requested_by = NEW.user_low THEN NEW.user_high ELSE NEW.user_low END; -- who answers
    IF NEW.status IN ('accepted', 'declined') AND OLD.status = 'pending' THEN
      UPDATE notifications SET read_at = now()
       WHERE user_id = v_other AND kind = 'friend_request' AND actor_id = NEW.requested_by AND read_at IS NULL;
    END IF;
    IF NEW.status = 'accepted' AND OLD.status <> 'accepted' THEN
      PERFORM _notify(NEW.requested_by, 'friend_accepted', v_other, '{}'::jsonb);
    END IF;
    RETURN NEW;
  ELSE
    -- the request was withdrawn (or the friendship removed): a stale "wants to be friends" must not linger
    v_other := CASE WHEN OLD.requested_by = OLD.user_low THEN OLD.user_high ELSE OLD.user_low END;
    DELETE FROM notifications
     WHERE user_id = v_other AND kind = 'friend_request' AND actor_id = OLD.requested_by AND read_at IS NULL;
    RETURN OLD;
  END IF;
END;
$$;
CREATE TRIGGER friendships_notify AFTER INSERT OR UPDATE OR DELETE ON friendships
  FOR EACH ROW EXECUTE FUNCTION _trg_friendship_notify();

-- A game invite: the other seat of a new 1v1 match.
CREATE FUNCTION _trg_match_player_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m matches;
  v_name text;
BEGIN
  SELECT * INTO m FROM matches WHERE id = NEW.match_id;
  IF NOT FOUND OR m.status <> 'invited' OR m.space_id IS NOT NULL OR NEW.user_id = m.created_by THEN
    RETURN NEW;
  END IF;
  SELECT name INTO v_name FROM games WHERE slug = m.game_slug;
  PERFORM _notify(
    NEW.user_id, 'game_invite', m.created_by,
    jsonb_build_object('matchId', m.id, 'gameSlug', m.game_slug, 'gameName', v_name, 'mode', m.mode,
                       'stakeKobo', m.stake_kobo, 'conversationId', m.conversation_id),
    'inv:' || m.id);
  RETURN NEW;
END;
$$;
CREATE TRIGGER match_players_notify AFTER INSERT ON match_players
  FOR EACH ROW EXECUTE FUNCTION _trg_match_player_notify();

-- Match lifecycle: accepted, your turn, countered, refunded, finished. Named so it fires after the XP trigger.
CREATE FUNCTION _trg_match_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  g games;
  base jsonb;
  p record;
  v_actor uuid;
  v_acceptor uuid;
  v_xp int;
BEGIN
  IF NEW.status IS NOT DISTINCT FROM OLD.status AND NEW.current_turn IS NOT DISTINCT FROM OLD.current_turn THEN
    RETURN NEW;
  END IF;
  SELECT * INTO g FROM games WHERE slug = NEW.game_slug;
  base := jsonb_build_object('matchId', NEW.id, 'gameSlug', NEW.game_slug, 'gameName', g.name,
                             'conversationId', NEW.conversation_id, 'spaceId', NEW.space_id, 'mode', NEW.mode);

  -- accepted: tell the person who was waiting (a counter-offer is accepted by the creator)
  IF OLD.status IN ('invited', 'countered') AND NEW.status = 'active' AND NEW.space_id IS NULL THEN
    UPDATE notifications SET read_at = now()
     WHERE dedupe_key IN ('inv:' || NEW.id, 'ctr:' || NEW.id) AND read_at IS NULL;
    v_acceptor := CASE WHEN OLD.status = 'invited'
                       THEN (SELECT user_id FROM match_players WHERE match_id = NEW.id AND user_id <> NEW.created_by LIMIT 1)
                       ELSE NEW.created_by END;
    v_actor := CASE WHEN v_acceptor = NEW.created_by
                    THEN (SELECT user_id FROM match_players WHERE match_id = NEW.id AND user_id <> NEW.created_by LIMIT 1)
                    ELSE NEW.created_by END;
    PERFORM _notify(
      v_actor, 'game_accepted', v_acceptor,
      base || jsonb_build_object('stakeKobo', NEW.stake_kobo, 'yourTurn', NEW.current_turn = v_actor));
    RETURN NEW;
  END IF;

  -- your turn (async 1v1; live rooms announce themselves)
  IF NEW.status = 'active' AND NEW.current_turn IS NOT NULL
     AND NEW.current_turn IS DISTINCT FROM OLD.current_turn
     AND NEW.space_id IS NULL AND g.sync = 'async' THEN
    UPDATE notifications SET read_at = now()
     WHERE dedupe_key = 'turn:' || NEW.id AND user_id <> NEW.current_turn AND read_at IS NULL;
    SELECT user_id INTO v_actor FROM match_players
     WHERE match_id = NEW.id AND user_id <> NEW.current_turn ORDER BY seat LIMIT 1;
    PERFORM _notify(NEW.current_turn, 'your_turn', v_actor,
                    base || jsonb_build_object('stakeKobo', NEW.stake_kobo), 'turn:' || NEW.id);
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status THEN RETURN NEW; END IF;

  -- a counter-offer: the creator is told
  IF NEW.status = 'countered' AND OLD.status = 'invited' THEN
    UPDATE notifications SET read_at = now() WHERE dedupe_key = 'inv:' || NEW.id AND read_at IS NULL;
    SELECT user_id INTO v_actor FROM match_players WHERE match_id = NEW.id AND user_id <> NEW.created_by LIMIT 1;
    PERFORM _notify(NEW.created_by, 'pool_countered', v_actor,
                    base || jsonb_build_object('stakeKobo', NEW.stake_kobo, 'counterStakeKobo', NEW.counter_stake_kobo),
                    'ctr:' || NEW.id);
    RETURN NEW;
  END IF;

  -- an invite that ended without being played: declined, expired or withdrawn
  IF NEW.status IN ('expired', 'cancelled') THEN
    UPDATE notifications SET read_at = now()
     WHERE dedupe_key IN ('inv:' || NEW.id, 'ctr:' || NEW.id, 'turn:' || NEW.id) AND read_at IS NULL;
    FOR p IN SELECT user_id, staked_kobo, payout_kobo FROM match_players
              WHERE match_id = NEW.id AND staked_kobo > 0 LOOP
      SELECT user_id INTO v_actor FROM match_players WHERE match_id = NEW.id AND user_id <> p.user_id ORDER BY seat LIMIT 1;
      PERFORM _notify(p.user_id, 'pool_refunded', v_actor,
                      base || jsonb_build_object('amountKobo', p.staked_kobo, 'reason', NEW.status::text));
    END LOOP;
    RETURN NEW;
  END IF;

  -- finished: a result for every player (Pool results are pushed; Free ones only appear in the list)
  IF NEW.status = 'finished' THEN
    UPDATE notifications SET read_at = now()
     WHERE dedupe_key IN ('inv:' || NEW.id, 'ctr:' || NEW.id, 'turn:' || NEW.id) AND read_at IS NULL;
    FOR p IN SELECT user_id, result, placement, staked_kobo, payout_kobo FROM match_players
              WHERE match_id = NEW.id AND result IS NOT NULL LOOP
      SELECT user_id INTO v_actor FROM match_players
       WHERE match_id = NEW.id AND user_id <> p.user_id
       ORDER BY (placement IS NOT DISTINCT FROM 1) DESC, seat LIMIT 1;
      IF (SELECT count(*) FROM match_players WHERE match_id = NEW.id) > 2 THEN v_actor := NULL; END IF;
      SELECT coalesce(sum(amount), 0) INTO v_xp FROM xp_events WHERE match_id = NEW.id AND user_id = p.user_id;
      PERFORM _notify(
        p.user_id,
        CASE WHEN p.staked_kobo > 0 THEN 'pool_result' ELSE 'game_result' END,
        v_actor,
        base || jsonb_build_object('result', p.result::text, 'placement', p.placement,
                                   'stakeKobo', p.staked_kobo, 'payoutKobo', coalesce(p.payout_kobo, 0), 'xp', v_xp));
    END LOOP;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER matches_2_notify AFTER UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION _trg_match_notify();

-- A space that starts: everyone seated except the host.
CREATE FUNCTION _trg_space_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_name text;
  m record;
BEGIN
  IF NEW.status = OLD.status THEN RETURN NEW; END IF;
  IF NEW.status = 'live' AND OLD.status = 'waiting' THEN
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
CREATE TRIGGER spaces_notify AFTER UPDATE ON spaces
  FOR EACH ROW EXECUTE FUNCTION _trg_space_notify();

-- Money: a request addressed to you, a request paid, a transfer to you.
CREATE FUNCTION _trg_payment_request_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_amount bigint;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.target_user IS NOT NULL AND NEW.status = 'open' THEN
      PERFORM _notify(NEW.target_user, 'money_requested', NEW.requester,
                      jsonb_build_object('code', NEW.code, 'amountKobo', NEW.amount_kobo),
                      'req:' || NEW.id, true);
    END IF;
  ELSIF NEW.status <> OLD.status THEN
    UPDATE notifications SET read_at = now() WHERE dedupe_key = 'req:' || NEW.id AND read_at IS NULL;
    IF NEW.status = 'paid' THEN
      SELECT (meta ->> 'amount_kobo')::bigint INTO v_amount FROM ledger_txns WHERE id = NEW.txn_id;
      PERFORM _notify(NEW.requester, 'money_received', NEW.paid_by,
                      jsonb_build_object('amountKobo', coalesce(v_amount, NEW.amount_kobo), 'viaRequest', true));
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER payment_requests_notify AFTER INSERT OR UPDATE ON payment_requests
  FOR EACH ROW EXECUTE FUNCTION _trg_payment_request_notify();

CREATE FUNCTION _trg_transfer_notify() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.kind = 'transfer' AND NEW.meta ? 'to_user' THEN
    PERFORM _notify((NEW.meta ->> 'to_user')::uuid, 'money_received', (NEW.meta ->> 'from_user')::uuid,
                    jsonb_build_object('amountKobo', (NEW.meta ->> 'amount_kobo')::bigint, 'viaRequest', false));
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER ledger_txns_notify AFTER INSERT ON ledger_txns
  FOR EACH ROW EXECUTE FUNCTION _trg_transfer_notify();

-- ---------------------------------------------------------------------------------------------
-- XP, levels, streaks and badges
-- ---------------------------------------------------------------------------------------------

-- A level takes 75 x its number in XP (ADR-023): Level 1 needs 75, Level 8 needs 600. `profiles.xp` is the
-- progress inside the current level, as the Profile screen shows it; `xp_events` keeps the running total.
CREATE FUNCTION xp_for_level(p_level int) RETURNS int
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$ SELECT 75 * greatest(p_level, 1) $$;

CREATE FUNCTION _grant_badge(p_user uuid, p_slug text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_name text;
  v_inserted int;
BEGIN
  INSERT INTO user_badges (user_id, badge_slug) VALUES (p_user, p_slug) ON CONFLICT DO NOTHING;
  GET DIAGNOSTICS v_inserted = ROW_COUNT;
  IF v_inserted = 1 THEN
    SELECT name INTO v_name FROM badges WHERE slug = p_slug;
    PERFORM _notify(p_user, 'badge_earned', NULL, jsonb_build_object('badge', p_slug, 'badgeName', v_name));
  END IF;
END;
$$;

CREATE FUNCTION _trg_match_progress() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_day date := (coalesce(NEW.finished_at, now()) AT TIME ZONE 'Africa/Lagos')::date;
  v_n int;
  v_cap int := cfg_bigint('xp_games_per_day', 30);
  v_pair_cap int := cfg_bigint('xp_pair_games_per_day', 5);
  p record;
  v_won boolean;
  v_add int;
  v_games_today int;
  v_pair_today int;
  v_level int;
  v_xp int;
  v_old_level int;
  v_cur int;
BEGIN
  IF NEW.status <> 'finished' OR OLD.status = 'finished' THEN RETURN NEW; END IF;
  SELECT count(*) INTO v_n FROM match_players WHERE match_id = NEW.id;

  FOR p IN SELECT user_id, result, placement FROM match_players
            WHERE match_id = NEW.id AND result IS NOT NULL ORDER BY seat LOOP
    CONTINUE WHEN p.result = 'forfeit';
    v_won := p.result = 'win' AND p.placement = 1;

    -- caps: the same person (or the same pair) cannot farm XP
    SELECT count(DISTINCT x.match_id) INTO v_games_today FROM xp_events x
     WHERE x.user_id = p.user_id AND x.match_id IS NOT NULL
       AND (x.created_at AT TIME ZONE 'Africa/Lagos')::date = v_day AND x.reason IN ('win', 'play', 'space_place');
    CONTINUE WHEN v_games_today >= v_cap;
    IF v_n = 2 THEN
      SELECT count(*) INTO v_pair_today FROM matches o
       WHERE o.id <> NEW.id AND o.status = 'finished' AND o.space_id IS NULL
         AND (o.finished_at AT TIME ZONE 'Africa/Lagos')::date = v_day
         AND (SELECT count(*) FROM match_players q WHERE q.match_id = o.id) = 2
         AND NOT EXISTS (
           SELECT 1 FROM match_players q
            WHERE q.match_id = o.id AND q.user_id NOT IN (SELECT user_id FROM match_players WHERE match_id = NEW.id));
      CONTINUE WHEN v_pair_today >= v_pair_cap;
    END IF;

    v_add := 0;
    IF v_n >= 3 THEN
      -- a Space: 60 for first, 30 for second, 15 for everyone else who played it out
      v_cur := CASE p.placement WHEN 1 THEN 60 WHEN 2 THEN 30 ELSE 15 END;
      INSERT INTO xp_events (user_id, amount, reason, match_id) VALUES (p.user_id, v_cur, 'space_place', NEW.id)
        ON CONFLICT DO NOTHING;
      IF FOUND THEN v_add := v_add + v_cur; END IF;
    ELSE
      IF v_won THEN
        INSERT INTO xp_events (user_id, amount, reason, match_id) VALUES (p.user_id, 25, 'win', NEW.id)
          ON CONFLICT DO NOTHING;
        IF FOUND THEN v_add := v_add + 25; END IF;
      ELSE
        INSERT INTO xp_events (user_id, amount, reason, match_id) VALUES (p.user_id, 10, 'play', NEW.id)
          ON CONFLICT DO NOTHING;
        IF FOUND THEN v_add := v_add + 10; END IF;
      END IF;
    END IF;
    CONTINUE WHEN v_add = 0; -- this match was already counted (a replay)

    -- +5 for the first game of the day
    IF NOT EXISTS (
      SELECT 1 FROM xp_events x
       WHERE x.user_id = p.user_id AND x.reason = 'daily_first'
         AND (x.created_at AT TIME ZONE 'Africa/Lagos')::date = v_day
    ) THEN
      INSERT INTO xp_events (user_id, amount, reason, match_id) VALUES (p.user_id, 5, 'daily_first', NEW.id)
        ON CONFLICT DO NOTHING;
      IF FOUND THEN v_add := v_add + 5; END IF;
    END IF;

    -- level: carry the surplus into the next level
    SELECT level, xp INTO v_old_level, v_xp FROM profiles WHERE id = p.user_id FOR UPDATE;
    CONTINUE WHEN NOT FOUND;
    v_level := v_old_level;
    v_xp := v_xp + v_add;
    WHILE v_xp >= xp_for_level(v_level) LOOP
      v_xp := v_xp - xp_for_level(v_level);
      v_level := v_level + 1;
    END LOOP;
    UPDATE profiles SET level = v_level, xp = v_xp WHERE id = p.user_id;
    IF v_level > v_old_level THEN
      PERFORM _notify(p.user_id, 'level_up', NULL, jsonb_build_object('level', v_level));
    END IF;

    IF v_won THEN
      -- streak: consecutive Lagos days with a win
      INSERT INTO streaks (user_id, current, best, last_win_date) VALUES (p.user_id, 1, 1, v_day)
      ON CONFLICT (user_id) DO UPDATE SET
        current = CASE WHEN streaks.last_win_date = v_day THEN streaks.current
                       WHEN streaks.last_win_date = v_day - 1 THEN streaks.current + 1
                       ELSE 1 END,
        last_win_date = greatest(coalesce(streaks.last_win_date, v_day), v_day);
      UPDATE streaks SET best = greatest(best, current) WHERE user_id = p.user_id;

      PERFORM _grant_badge(p.user_id, 'first-win');
      IF (SELECT current FROM streaks WHERE user_id = p.user_id) >= 10 THEN
        PERFORM _grant_badge(p.user_id, 'streak-10');
      END IF;
      IF (SELECT count(*) FROM match_players mp JOIN matches mm ON mm.id = mp.match_id
           WHERE mp.user_id = p.user_id AND mp.result = 'win' AND mp.staked_kobo > 0
             AND mm.status = 'finished') >= 5 THEN
        PERFORM _grant_badge(p.user_id, 'pool-shark');
      END IF;
      IF NEW.game_slug = 'whot' AND (SELECT count(*) FROM match_players mp JOIN matches mm ON mm.id = mp.match_id
           WHERE mp.user_id = p.user_id AND mp.result = 'win' AND mm.game_slug = 'whot'
             AND mm.status = 'finished') >= 10 THEN
        PERFORM _grant_badge(p.user_id, 'whot-master');
      END IF;
    END IF;
    IF NEW.space_id IS NOT NULL AND v_n >= 4
       AND EXISTS (SELECT 1 FROM spaces s WHERE s.id = NEW.space_id AND s.host_id = p.user_id) THEN
      PERFORM _grant_badge(p.user_id, 'space-host');
    END IF;
  END LOOP;
  RETURN NEW;
END;
$$;
CREATE TRIGGER matches_1_progress AFTER UPDATE ON matches
  FOR EACH ROW EXECUTE FUNCTION _trg_match_progress();

-- None of these are callable from outside: they run as triggers (and _notify / _grant_badge from them).
REVOKE EXECUTE ON FUNCTION
  _notify(uuid, text, uuid, jsonb, text, boolean),
  _grant_badge(uuid, text),
  _trg_friendship_notify(), _trg_match_player_notify(), _trg_match_notify(), _trg_space_notify(),
  _trg_payment_request_notify(), _trg_transfer_notify(), _trg_match_progress()
FROM PUBLIC;
