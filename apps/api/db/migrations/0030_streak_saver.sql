-- Streak lost and the streak saver (SPEC section 9, design StreakLost; ADR-042).
--
-- A streak is the number of consecutive Lagos days with a win (0018). It is ALIVE on the day of the last win and
-- on the day after; it ENDS when a whole day passes with no win. The day it ended is `lost_on` (the first day
-- with no win). The person then has the whole next Lagos day (24 hours) to win one Free game: that win brings the
-- old length back (`saver_expires_at` is the end of that day). A saver is used once: after a restore the next one
-- is offered only after `streak_saver_cooldown_days`, and only for a streak of at least `streak_saver_min_length`.
-- Nothing here moves money; XP and badges are untouched.
--
-- Where the loss is noticed: `_streak_roll` (idempotent) is called by the hourly sweep, by a win (so a win that
-- arrives before the sweep still sees the loss), and when the person opens the streak screen.

ALTER TABLE streaks
  ADD COLUMN lost_length    int CHECK (lost_length IS NULL OR lost_length > 0),
  ADD COLUMN lost_on        date,
  -- who beat them on the day it ended, if anyone did (the screen's "Amaka broke it" and its rematch button)
  ADD COLUMN lost_to        uuid REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN lost_seen_at   timestamptz,
  -- when a saver last restored a streak (the cooldown)
  ADD COLUMN saver_used_at  timestamptz;
-- saver_expires_at (0003) is NULL when no saver is on offer for the lost streak.

INSERT INTO app_config (key, value) VALUES
  ('streak_saver_min_length',    '2'),
  ('streak_saver_cooldown_days', '7')
ON CONFLICT (key) DO NOTHING;

-- Notices the loss of a streak that has gone a whole day without a win (as of p_today, default: today in Lagos).
-- Safe to call any time, any number of times.
CREATE FUNCTION _streak_roll(p_user uuid, p_today date DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s streaks;
  v_today date := coalesce(p_today, lagos_today());
  v_lost_on date;
  v_saver boolean;
  v_expires timestamptz;
  v_to uuid;
BEGIN
  SELECT * INTO s FROM streaks WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND OR s.current <= 0 OR s.last_win_date IS NULL OR s.last_win_date >= v_today - 1 THEN RETURN; END IF;

  -- A streak of a single day is not worth a screen or a saver: it just starts again.
  IF s.current < cfg_bigint('streak_saver_min_length', 2) THEN
    UPDATE streaks SET current = 0 WHERE user_id = p_user;
    RETURN;
  END IF;

  v_lost_on := s.last_win_date + 1;
  v_saver := (s.saver_used_at IS NULL
              OR s.saver_used_at <= now() - make_interval(days => cfg_bigint('streak_saver_cooldown_days', 7)::int));
  -- the saver day is the day after the one the streak ended on: the 24 hours end at the next Lagos midnight
  v_expires := CASE WHEN v_saver THEN ((s.last_win_date + 3)::timestamp AT TIME ZONE 'Africa/Lagos') END;

  SELECT other.user_id INTO v_to
    FROM match_players me
    JOIN matches m ON m.id = me.match_id AND m.status = 'finished' AND m.space_id IS NULL
    JOIN match_players other ON other.match_id = m.id AND other.user_id <> p_user
   WHERE me.user_id = p_user AND me.result IN ('loss', 'forfeit')
     AND (SELECT count(*) FROM match_players q WHERE q.match_id = m.id) = 2
     AND (m.finished_at AT TIME ZONE 'Africa/Lagos')::date = v_lost_on
   ORDER BY m.finished_at DESC LIMIT 1;

  UPDATE streaks
     SET lost_length = s.current, lost_on = v_lost_on, lost_to = v_to, lost_seen_at = NULL,
         saver_expires_at = v_expires, current = 0
   WHERE user_id = p_user;

  -- Only tell them while it still matters (not when this is noticed weeks late).
  IF v_today <= s.last_win_date + 3 THEN
    PERFORM _notify(
      p_user, 'streak_lost', v_to,
      jsonb_build_object('length', s.current, 'best', s.best, 'saver', v_saver,
                         'saverExpiresAt', v_expires, 'lostOn', v_lost_on),
      'streak-lost:' || v_lost_on);
  END IF;
END;
$$;

-- A win. Extends the streak, or starts a new one, or (a Free win inside the saver's 24 hours) restores the one
-- that ended. The restoring win is the day's win: the streak is back at its old length and the next day's win makes
-- it one longer.
CREATE FUNCTION _streak_win(p_user uuid, p_at timestamptz, p_free boolean) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  s streaks;
  v_day date := (p_at AT TIME ZONE 'Africa/Lagos')::date;
BEGIN
  INSERT INTO streaks (user_id, current, best, last_win_date) VALUES (p_user, 0, 0, NULL)
    ON CONFLICT (user_id) DO NOTHING;
  PERFORM _streak_roll(p_user, v_day);
  SELECT * INTO s FROM streaks WHERE user_id = p_user FOR UPDATE;

  IF p_free AND s.lost_length IS NOT NULL AND s.saver_expires_at IS NOT NULL
     AND p_at < s.saver_expires_at AND v_day > s.lost_on THEN
    UPDATE streaks
       SET current = lost_length, best = greatest(best, lost_length), last_win_date = v_day,
           saver_used_at = p_at, saver_expires_at = NULL,
           lost_length = NULL, lost_on = NULL, lost_to = NULL, lost_seen_at = NULL
     WHERE user_id = p_user;
    RETURN;
  END IF;

  UPDATE streaks
     SET current = CASE WHEN last_win_date = v_day THEN current
                        WHEN last_win_date = v_day - 1 THEN current + 1
                        ELSE 1 END,
         last_win_date = greatest(coalesce(last_win_date, v_day), v_day)
   WHERE user_id = p_user;
  UPDATE streaks SET best = greatest(best, current) WHERE user_id = p_user;
END;
$$;

-- The hourly sweep: everyone whose streak went a whole day without a win. Returns how many it noticed.
CREATE FUNCTION streak_sweep() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r record;
  n int := 0;
BEGIN
  FOR r IN SELECT user_id FROM streaks WHERE current > 0 AND last_win_date < lagos_today() - 1 LOOP
    PERFORM _streak_roll(r.user_id);
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- The streak screen opens: notice a loss that nobody has noticed yet, then the person reads their own row.
CREATE FUNCTION streak_check(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT _streak_roll(p_user)
$$;

-- "Not now" / seen: the screen is not shown again for this loss. Idempotent.
CREATE FUNCTION streak_mark_seen(p_user uuid) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp AS $$
  UPDATE streaks SET lost_seen_at = coalesce(lost_seen_at, now())
   WHERE user_id = p_user AND lost_length IS NOT NULL
$$;

REVOKE EXECUTE ON FUNCTION _streak_roll(uuid, date), _streak_win(uuid, timestamptz, boolean) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION streak_sweep(), streak_check(uuid), streak_mark_seen(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION streak_sweep(), streak_check(uuid), streak_mark_seen(uuid) TO dyce_api;

-- The award trigger, as in 0018 except that the streak is kept by _streak_win.
CREATE OR REPLACE FUNCTION _trg_match_progress() RETURNS trigger
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
      -- streak: consecutive Lagos days with a win, and the streak saver (see _streak_win)
      PERFORM _streak_win(p.user_id, coalesce(NEW.finished_at, now()), NEW.mode = 'free');

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
