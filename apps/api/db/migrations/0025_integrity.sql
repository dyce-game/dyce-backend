-- Integrity layer (ADR-039): Pool anti-cheat and collusion signals, payout holds, the request spam filter, the
-- moderation queue with its audit log, and the sanctions a moderator can apply.
--
-- Money. Nothing here adds a way to move money. A payout hold is a *delay* of `settle_match`: the match is judged
-- once, at the moment it would settle (`settle_or_hold`), and a held match keeps its stakes in the escrow it
-- already has. A moderator then releases (`settle_match` as decided), voids (`refund_match`) or disqualifies one
-- player (placements rewritten, then `settle_match`). Signals never change a balance, never ban, never suspend.
--
-- Roles. Moderation is run by a separate database role, `dyce_admin`, that the public API does not use: the admin
-- API opens its own pool (ADMIN_DATABASE_URL). `dyce_api` cannot resolve a hold, act on a report or read the
-- moderation views (the same line ADR-037 drew for `resolve_dispute`).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dyce_admin') THEN
    CREATE ROLE dyce_admin NOLOGIN;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END
$$;
GRANT USAGE ON SCHEMA public TO dyce_admin;

INSERT INTO app_config (key, value) VALUES
  -- Pool: what a score means (0 to 100, the sum of a match's signals, capped)
  ('integrity_hold_threshold',      '70'),   -- at or over: the payout waits for a person
  ('integrity_flag_threshold',      '40'),   -- at or over: the match's signals go to the moderation queue
  ('integrity_min_signal_score',    '20'),   -- weaker signals are not stored at all
  ('integrity_hold_max_hours',      '72'),   -- a hold nobody decided pays out as originally decided after this long
  ('integrity_pair_days',           '7'),
  ('integrity_pair_matches',        '5'),    -- the same two accounts in this many Pool matches inside the window
  ('integrity_one_sided_min',       '4'),    -- the same two accounts, this many decided matches, one side won every one
  ('integrity_shared_device_days',  '30'),
  ('integrity_shared_ip_days',      '7'),
  ('integrity_feeder_days',         '7'),    -- an account this young that keeps losing to one account
  ('integrity_feeder_min_matches',  '3'),
  ('integrity_feeder_share_pct',    '80'),
  ('integrity_feeder_network_min',  '3'),    -- one account paid by this many young accounts
  ('integrity_timing_hits',         '3'),    -- inputs faster than a person, this many times in one match
  ('fingerprint_retention_days',    '90'),
  -- Requests: the spam filter
  ('spam_filter_threshold',         '50'),
  ('spam_new_account_hours',        '24'),
  ('spam_mass_per_hour',            '8'),
  ('spam_declines_30d',             '3'),
  ('spam_reports_30d',              '1'),
  -- Device integrity (Play Integrity / App Attest): a nonce stays valid this long
  ('attestation_challenge_minutes', '5')
ON CONFLICT (key) DO NOTHING;

-- The ledger's "every transaction balances" check is a deferred constraint trigger (0004), and a deferred trigger
-- runs as the role that opened the transaction, not as the function that fired it. The moderation role settles and
-- refunds held matches through SECURITY DEFINER functions but has (rightly) no access to ledger tables, so the check
-- would fail at COMMIT. It only reads, so it runs as its owner like every other money function.
ALTER FUNCTION ledger_txn_balanced() SECURITY DEFINER SET search_path = public, pg_temp;

-- ---------------------------------------------------------------------------------------------
-- who is playing from where: keyed hashes of the install id and the IP, nothing readable
-- ---------------------------------------------------------------------------------------------

CREATE TABLE user_fingerprints (
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('device', 'ip')),
  value_hash    bytea NOT NULL,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz NOT NULL DEFAULT now(),
  seen_count    int NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, kind, value_hash)
);
CREATE INDEX user_fingerprints_value_idx ON user_fingerprints (kind, value_hash);
CREATE INDEX user_fingerprints_seen_idx ON user_fingerprints (last_seen_at);

-- A deleted account loses its fingerprints at once (NDPA: they were only ever there to spot abuse).
CREATE FUNCTION _trg_user_disabled_cleanup() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  DELETE FROM user_fingerprints WHERE user_id = NEW.id;
  RETURN NEW;
END;
$$;
CREATE TRIGGER users_disabled_cleanup AFTER UPDATE OF disabled_at ON users
  FOR EACH ROW WHEN (OLD.disabled_at IS NULL AND NEW.disabled_at IS NOT NULL)
  EXECUTE FUNCTION _trg_user_disabled_cleanup();

CREATE FUNCTION record_fingerprints(p_user uuid, p_device bytea, p_ip bytea) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_device IS NOT NULL THEN
    INSERT INTO user_fingerprints (user_id, kind, value_hash) VALUES (p_user, 'device', p_device)
    ON CONFLICT (user_id, kind, value_hash)
    DO UPDATE SET last_seen_at = now(), seen_count = user_fingerprints.seen_count + 1;
  END IF;
  IF p_ip IS NOT NULL THEN
    INSERT INTO user_fingerprints (user_id, kind, value_hash) VALUES (p_user, 'ip', p_ip)
    ON CONFLICT (user_id, kind, value_hash)
    DO UPDATE SET last_seen_at = now(), seen_count = user_fingerprints.seen_count + 1;
  END IF;
END;
$$;

-- Two accounts that have used the same phone or the same connection (quick match uses it to never pair them).
CREATE FUNCTION users_share_fingerprint(p_a uuid, p_b uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_fingerprints fa
      JOIN user_fingerprints fb ON fb.kind = fa.kind AND fb.value_hash = fa.value_hash
     WHERE fa.user_id = p_a AND fb.user_id = p_b);
$$;

CREATE FUNCTION integrity_prune_fingerprints() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE n int;
BEGIN
  DELETE FROM user_fingerprints
   WHERE last_seen_at < now() - make_interval(days => cfg_bigint('fingerprint_retention_days', 90)::int);
  GET DIAGNOSTICS n = ROW_COUNT;
  DELETE FROM stranger_scans WHERE day < lagos_today() - 7;
  RETURN n;
END;
$$;

-- Codes a person has opened that belong to someone outside their friends and contacts, one row per code per day
-- (SPEC: 20 a day, `stranger_scans_per_day`). Looking at the same code again costs nothing.
CREATE TABLE stranger_scans (
  user_id  uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day      date NOT NULL,
  code     text NOT NULL,
  PRIMARY KEY (user_id, day, code)
);
GRANT SELECT, INSERT ON stranger_scans TO dyce_api;

-- ---------------------------------------------------------------------------------------------
-- signals, holds, sanctions, audit
-- ---------------------------------------------------------------------------------------------

-- Per-game rules for "faster than a person" and "the same input again and again". NULL = not checked.
-- gap_basis 'previous' = since the previous move by anyone; 'own' = since your own previous move (Word Hunt:
-- Start, then Submit).
CREATE TABLE integrity_game_rules (
  game_slug    text PRIMARY KEY REFERENCES games(slug),
  min_gap_ms   int CHECK (min_gap_ms IS NULL OR min_gap_ms > 0),
  gap_basis    text NOT NULL DEFAULT 'previous' CHECK (gap_basis IN ('previous', 'own')),
  max_repeat   int CHECK (max_repeat IS NULL OR max_repeat >= 2)
);
INSERT INTO integrity_game_rules (game_slug, min_gap_ms, gap_basis, max_repeat)
SELECT g.slug, v.min_gap_ms, v.gap_basis, v.max_repeat
  FROM games g
  JOIN (VALUES
    ('word-hunt',   3000, 'own',      NULL::int),
    ('anagrams',    3000, 'own',      NULL),
    ('cup-pong',     300, 'previous', 6),
    ('eight-ball',   300, 'previous', 6),
    ('darts',        300, 'previous', 6),
    ('basketball',   300, 'previous', 6),
    ('archery',      300, 'previous', 6),
    ('mini-golf',    300, 'previous', 6),
    ('tanks',        300, 'previous', 6),
    ('chess',        200, 'previous', NULL),
    ('checkers',     200, 'previous', NULL),
    ('ayo',          200, 'previous', NULL),
    ('dots-and-boxes', 200, 'previous', NULL),
    ('ludo',         200, 'previous', NULL),
    ('sea-battle',   200, 'previous', NULL),
    ('filler',       200, 'previous', NULL),
    ('word-tiles',   200, 'previous', NULL),
    ('whot',         200, 'previous', NULL),
    ('crazy-cards',  200, 'previous', NULL)
  ) AS v(slug, min_gap_ms, gap_basis, max_repeat) ON v.slug = g.slug
ON CONFLICT (game_slug) DO NOTHING;

CREATE TABLE integrity_signals (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN (
    'timing_impossible', 'input_repeat', 'pair_repeat', 'pair_one_sided', 'shared_device', 'shared_ip',
    'feeder_account', 'feeder_network', 'cheat_reports', 'attestation_failed')),
  score         int NOT NULL CHECK (score BETWEEN 0 AND 100),
  subject_user  uuid REFERENCES users(id),
  other_user    uuid REFERENCES users(id),
  match_id      uuid REFERENCES matches(id),
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  -- in the moderation queue (the match's signals added up to the flag threshold)
  flagged       boolean NOT NULL DEFAULT false,
  status        text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'reviewing', 'actioned', 'dismissed')),
  dedupe_key    text NOT NULL UNIQUE,
  created_at    timestamptz NOT NULL DEFAULT now(),
  reviewed_by   text,
  reviewed_at   timestamptz,
  review_note   text CHECK (review_note IS NULL OR char_length(review_note) <= 1000)
);
CREATE INDEX integrity_signals_queue_idx ON integrity_signals (created_at) WHERE flagged AND status IN ('open', 'reviewing');
CREATE INDEX integrity_signals_match_idx ON integrity_signals (match_id);
CREATE INDEX integrity_signals_subject_idx ON integrity_signals (subject_user, kind, created_at DESC);

CREATE TABLE integrity_holds (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  match_id          uuid NOT NULL UNIQUE REFERENCES matches(id),
  total_score       int NOT NULL CHECK (total_score BETWEEN 0 AND 100),
  status            text NOT NULL DEFAULT 'held' CHECK (status IN ('held', 'released', 'voided', 'disqualified')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  lapses_at         timestamptz NOT NULL,
  decided_at        timestamptz,
  decided_by        text,
  decision_note     text CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
  disqualified_user uuid REFERENCES users(id),
  resolution_txn    uuid,
  CONSTRAINT integrity_holds_decided_chk CHECK ((status = 'held') = (decided_at IS NULL))
);
CREATE INDEX integrity_holds_open_idx ON integrity_holds (lapses_at) WHERE status = 'held';

CREATE TABLE user_sanctions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id),
  kind        text NOT NULL CHECK (kind IN ('warning', 'mute', 'suspension')),
  report_id   uuid REFERENCES reports(id),
  signal_id   uuid REFERENCES integrity_signals(id),
  note        text CHECK (note IS NULL OR char_length(note) <= 1000),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- NULL = until lifted (suspensions only)
  expires_at  timestamptz,
  lifted_at   timestamptz,
  lifted_by   text,
  froze_pool  boolean NOT NULL DEFAULT false
);
CREATE INDEX user_sanctions_user_idx ON user_sanctions (user_id, created_at DESC);

ALTER TABLE users
  ADD COLUMN muted_until     timestamptz,
  ADD COLUMN suspended_until timestamptz;

-- Append-only: who did what, when, to whom, and why. A moderator cannot act without leaving a row (the functions
-- below write it in the same transaction) and cannot remove one.
CREATE TABLE moderation_actions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin        text NOT NULL CHECK (admin <> ''),
  action       text NOT NULL,
  target_user  uuid REFERENCES users(id),
  report_id    uuid REFERENCES reports(id),
  signal_id    uuid REFERENCES integrity_signals(id),
  hold_id      uuid REFERENCES integrity_holds(id),
  dispute_id   uuid REFERENCES disputes(id),
  sanction_id  uuid REFERENCES user_sanctions(id),
  note         text,
  meta         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX moderation_actions_time_idx ON moderation_actions (created_at DESC);
CREATE INDEX moderation_actions_target_idx ON moderation_actions (target_user, created_at DESC);

CREATE FUNCTION _trg_moderation_actions_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'dyce:audit_immutable';
END;
$$;
CREATE TRIGGER moderation_actions_no_change BEFORE UPDATE OR DELETE ON moderation_actions
  FOR EACH ROW EXECUTE FUNCTION _trg_moderation_actions_immutable();
CREATE TRIGGER moderation_actions_no_truncate BEFORE TRUNCATE ON moderation_actions
  FOR EACH STATEMENT EXECUTE FUNCTION _trg_moderation_actions_immutable();

ALTER TABLE reports
  ADD COLUMN reviewed_by          text,
  ADD COLUMN reviewed_at          timestamptz,
  ADD COLUMN outcome              text CHECK (outcome IS NULL OR outcome IN ('warned', 'muted', 'suspended', 'dismissed')),
  ADD COLUMN decision_note        text CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
  ADD COLUMN reporter_notified_at timestamptz;
CREATE INDEX reports_queue_idx ON reports (created_at) WHERE status IN ('open', 'reviewing');

-- The request spam filter: a filtered request is still a request (nothing is deleted), shown in its own bucket.
ALTER TABLE conversation_members
  ADD COLUMN filtered_at   timestamptz,
  ADD COLUMN filter_reason text;
CREATE INDEX conversation_members_filtered_idx ON conversation_members (user_id) WHERE filtered_at IS NOT NULL;

-- ---------------------------------------------------------------------------------------------
-- internal helpers
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION _moderation_log(
  p_admin text, p_action text, p_target uuid, p_note text, p_meta jsonb,
  p_report uuid DEFAULT NULL, p_signal uuid DEFAULT NULL, p_hold uuid DEFAULT NULL,
  p_dispute uuid DEFAULT NULL, p_sanction uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE v_id uuid;
BEGIN
  IF p_admin IS NULL OR btrim(p_admin) = '' THEN RAISE EXCEPTION 'dyce:admin_required'; END IF;
  INSERT INTO moderation_actions (admin, action, target_user, report_id, signal_id, hold_id, dispute_id,
                                  sanction_id, note, meta)
  VALUES (p_admin, p_action, p_target, p_report, p_signal, p_hold, p_dispute, p_sanction, p_note,
          coalesce(p_meta, '{}'::jsonb))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- Records (or refreshes) one signal; returns the score it carries. Never reopens a reviewed one.
CREATE FUNCTION _integrity_signal(
  p_kind text, p_score int, p_subject uuid, p_other uuid, p_match uuid, p_detail jsonb, p_dedupe text
) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF p_score < cfg_bigint('integrity_min_signal_score', 20) THEN RETURN 0; END IF;
  INSERT INTO integrity_signals (kind, score, subject_user, other_user, match_id, detail, dedupe_key)
  VALUES (p_kind, least(p_score, 100), p_subject, p_other, p_match, coalesce(p_detail, '{}'::jsonb), p_dedupe)
  ON CONFLICT (dedupe_key) DO UPDATE SET score = EXCLUDED.score, detail = EXCLUDED.detail;
  RETURN least(p_score, 100);
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- Pool: judge a match when it would settle
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION integrity_evaluate_match(p_match uuid) RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m matches;
  rule integrity_game_rules;
  r record;
  v_pair_days   int := cfg_bigint('integrity_pair_days', 7)::int;
  v_pair_min    int := cfg_bigint('integrity_pair_matches', 5)::int;
  v_one_min     int := cfg_bigint('integrity_one_sided_min', 4)::int;
  v_dev_days    int := cfg_bigint('integrity_shared_device_days', 30)::int;
  v_ip_days     int := cfg_bigint('integrity_shared_ip_days', 7)::int;
  v_feed_days   int := cfg_bigint('integrity_feeder_days', 7)::int;
  v_feed_min    int := cfg_bigint('integrity_feeder_min_matches', 3)::int;
  v_feed_pct    int := cfg_bigint('integrity_feeder_share_pct', 80)::int;
  v_net_min     int := cfg_bigint('integrity_feeder_network_min', 3)::int;
  v_hits        int := cfg_bigint('integrity_timing_hits', 3)::int;
  v_flag        int := cfg_bigint('integrity_flag_threshold', 40)::int;
  v_total int := 0;
  v_n int; v_a_wins int; v_b_wins int; v_with int; v_all int; v_in int; v_any int;
  v_winner uuid; v_loser uuid;
  v_has_rule boolean;
BEGIN
  SELECT * INTO m FROM matches WHERE id = p_match;
  IF NOT FOUND OR m.mode <> 'pool' THEN RETURN 0; END IF;

  -- ---- pairs of staked players -----------------------------------------------------------------
  FOR r IN
    SELECT p1.user_id AS a, p2.user_id AS b, p1.placement AS pa, p2.placement AS pb
      FROM match_players p1
      JOIN match_players p2 ON p2.match_id = p1.match_id AND p1.user_id < p2.user_id
     WHERE p1.match_id = p_match AND p1.staked_kobo > 0 AND p2.staked_kobo > 0
  LOOP
    -- the same two accounts keep meeting in Pool
    SELECT count(DISTINCT x.id) INTO v_n
      FROM matches x
      JOIN match_players q1 ON q1.match_id = x.id AND q1.user_id = r.a AND q1.staked_kobo > 0
      JOIN match_players q2 ON q2.match_id = x.id AND q2.user_id = r.b AND q2.staked_kobo > 0
     WHERE x.mode = 'pool' AND x.status NOT IN ('invited', 'countered', 'expired', 'cancelled')
       AND x.created_at >= now() - make_interval(days => v_pair_days);
    IF v_n >= v_pair_min THEN
      v_total := v_total + _integrity_signal('pair_repeat', least(60, 30 + 10 * (v_n - v_pair_min)), r.a, r.b, p_match,
        jsonb_build_object('matches', v_n, 'days', v_pair_days), 'pair_repeat:' || p_match || ':' || r.a || ':' || r.b);
    END IF;

    -- and one of them wins every time
    SELECT count(*),
           count(*) FILTER (WHERE q1.placement < q2.placement),
           count(*) FILTER (WHERE q2.placement < q1.placement)
      INTO v_n, v_a_wins, v_b_wins
      FROM matches x
      JOIN match_players q1 ON q1.match_id = x.id AND q1.user_id = r.a AND q1.staked_kobo > 0
      JOIN match_players q2 ON q2.match_id = x.id AND q2.user_id = r.b AND q2.staked_kobo > 0
     WHERE x.mode = 'pool' AND x.created_at >= now() - make_interval(days => v_pair_days * 2)
       AND q1.placement IS NOT NULL AND q2.placement IS NOT NULL
       AND (x.id = p_match OR x.status IN ('finished', 'disputed'));
    IF v_n >= v_one_min AND (v_a_wins = v_n OR v_b_wins = v_n) THEN
      v_winner := CASE WHEN v_a_wins = v_n THEN r.a ELSE r.b END;
      v_loser  := CASE WHEN v_a_wins = v_n THEN r.b ELSE r.a END;
      v_total := v_total + _integrity_signal('pair_one_sided', 30, v_winner, v_loser, p_match,
        jsonb_build_object('matches', v_n), 'pair_one_sided:' || p_match || ':' || r.a || ':' || r.b);
    END IF;

    -- one phone or one connection behind two accounts
    IF EXISTS (
      SELECT 1 FROM user_fingerprints fa
        JOIN user_fingerprints fb ON fb.kind = fa.kind AND fb.value_hash = fa.value_hash
       WHERE fa.user_id = r.a AND fb.user_id = r.b AND fa.kind = 'device'
         AND fa.last_seen_at >= now() - make_interval(days => v_dev_days)
         AND fb.last_seen_at >= now() - make_interval(days => v_dev_days)
    ) THEN
      v_total := v_total + _integrity_signal('shared_device', 60, r.a, r.b, p_match,
        jsonb_build_object('days', v_dev_days), 'shared_device:' || p_match || ':' || r.a || ':' || r.b);
    END IF;
    IF EXISTS (
      SELECT 1 FROM user_fingerprints fa
        JOIN user_fingerprints fb ON fb.kind = fa.kind AND fb.value_hash = fa.value_hash
       WHERE fa.user_id = r.a AND fb.user_id = r.b AND fa.kind = 'ip'
         AND fa.last_seen_at >= now() - make_interval(days => v_ip_days)
         AND fb.last_seen_at >= now() - make_interval(days => v_ip_days)
    ) THEN
      v_total := v_total + _integrity_signal('shared_ip', 25, r.a, r.b, p_match,
        jsonb_build_object('days', v_ip_days), 'shared_ip:' || p_match || ':' || r.a || ':' || r.b);
    END IF;

    -- a young account that keeps losing to this one
    IF r.pa IS NOT NULL AND r.pb IS NOT NULL AND r.pa <> r.pb THEN
      v_winner := CASE WHEN r.pa < r.pb THEN r.a ELSE r.b END;
      v_loser  := CASE WHEN r.pa < r.pb THEN r.b ELSE r.a END;
      IF (SELECT created_at FROM users WHERE id = v_loser) >= now() - make_interval(days => v_feed_days) THEN
        SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM match_players w WHERE w.match_id = x.id AND w.user_id = v_winner)),
               count(*)
          INTO v_with, v_all
          FROM match_players ml JOIN matches x ON x.id = ml.match_id
         WHERE ml.user_id = v_loser AND ml.staked_kobo > 0 AND x.mode = 'pool' AND ml.placement IS NOT NULL
           AND (x.id = p_match OR x.status IN ('finished', 'disputed'));
        IF v_with >= v_feed_min AND v_with * 100 >= v_all * v_feed_pct THEN
          v_total := v_total + _integrity_signal('feeder_account', 50, v_winner, v_loser, p_match,
            jsonb_build_object('matchesWithWinner', v_with, 'matches', v_all),
            'feeder_account:' || p_match || ':' || v_winner || ':' || v_loser);
        END IF;
      END IF;
    END IF;
  END LOOP;

  -- ---- winners paid by several young accounts ----------------------------------------------------
  FOR r IN SELECT user_id FROM match_players WHERE match_id = p_match AND placement = 1 AND staked_kobo > 0 LOOP
    SELECT count(DISTINCT l.user_id) INTO v_n
      FROM match_players w
      JOIN match_players l ON l.match_id = w.match_id AND l.user_id <> w.user_id AND l.staked_kobo > 0
      JOIN matches x ON x.id = w.match_id
      JOIN users ul ON ul.id = l.user_id
     WHERE w.user_id = r.user_id AND w.staked_kobo > 0 AND w.placement < l.placement
       AND x.mode = 'pool' AND x.created_at >= now() - make_interval(days => v_pair_days)
       AND (x.id = p_match OR x.status IN ('finished', 'disputed'))
       AND ul.created_at >= now() - make_interval(days => v_feed_days);
    IF v_n >= v_net_min THEN
      v_total := v_total + _integrity_signal('feeder_network', 40, r.user_id, NULL, p_match,
        jsonb_build_object('youngAccounts', v_n), 'feeder_network:' || p_match || ':' || r.user_id);
    END IF;
  END LOOP;

  -- ---- how each player played --------------------------------------------------------------------
  SELECT * INTO rule FROM integrity_game_rules WHERE game_slug = m.game_slug;
  v_has_rule := FOUND;
  IF v_has_rule AND rule.min_gap_ms IS NOT NULL THEN
    FOR r IN
      WITH mv AS (
        SELECT user_id, created_at,
               lag(created_at) OVER (ORDER BY seq)                     AS prev_any,
               lag(created_at) OVER (PARTITION BY user_id ORDER BY seq) AS prev_own
          FROM match_moves WHERE match_id = p_match AND user_id IS NOT NULL
      )
      SELECT user_id, count(*) AS hits FROM mv
       WHERE extract(epoch FROM (created_at - CASE rule.gap_basis WHEN 'own' THEN prev_own ELSE prev_any END)) * 1000
             < rule.min_gap_ms
       GROUP BY user_id HAVING count(*) >= v_hits
    LOOP
      v_total := v_total + _integrity_signal('timing_impossible', 45, r.user_id, NULL, p_match,
        jsonb_build_object('hits', r.hits, 'minGapMs', rule.min_gap_ms, 'game', m.game_slug),
        'timing_impossible:' || p_match || ':' || r.user_id);
    END LOOP;
  END IF;
  IF v_has_rule AND rule.max_repeat IS NOT NULL THEN
    FOR r IN
      WITH s AS (
        SELECT user_id, seq, action,
               lag(action) OVER (PARTITION BY user_id ORDER BY seq) AS pa
          FROM match_moves WHERE match_id = p_match AND user_id IS NOT NULL
      ), runs AS (
        SELECT user_id, sum((action IS DISTINCT FROM pa)::int) OVER (PARTITION BY user_id ORDER BY seq) AS run
          FROM s
      ), longest AS (
        SELECT user_id, run, count(*) AS n FROM runs GROUP BY user_id, run
      )
      SELECT user_id, max(n) AS n FROM longest GROUP BY user_id HAVING max(n) >= rule.max_repeat
    LOOP
      v_total := v_total + _integrity_signal('input_repeat', 25, r.user_id, NULL, p_match,
        jsonb_build_object('repeats', r.n, 'game', m.game_slug), 'input_repeat:' || p_match || ':' || r.user_id);
    END LOOP;
  END IF;

  -- ---- what other people and the device check said -----------------------------------------------
  FOR r IN SELECT user_id FROM match_players WHERE match_id = p_match LOOP
    SELECT count(DISTINCT rep.reporter_id) FILTER (WHERE rep.reporter_id IN (SELECT user_id FROM match_players WHERE match_id = p_match)),
           count(DISTINCT rep.reporter_id)
      INTO v_in, v_any
      FROM reports rep
     WHERE rep.target_user_id = r.user_id AND rep.reason = 'cheat' AND rep.status IN ('open', 'reviewing')
       AND rep.created_at >= now() - interval '14 days';
    IF v_in >= 1 THEN
      v_total := v_total + _integrity_signal('cheat_reports', 40, r.user_id, NULL, p_match,
        jsonb_build_object('reportersInMatch', v_in, 'reporters', v_any), 'cheat_reports:' || p_match || ':' || r.user_id);
    ELSIF v_any >= 3 THEN
      v_total := v_total + _integrity_signal('cheat_reports', 30, r.user_id, NULL, p_match,
        jsonb_build_object('reportersInMatch', 0, 'reporters', v_any), 'cheat_reports:' || p_match || ':' || r.user_id);
    END IF;

    IF EXISTS (SELECT 1 FROM integrity_signals s
                WHERE s.kind = 'attestation_failed' AND s.subject_user = r.user_id AND s.match_id IS NULL
                  AND s.created_at >= now() - interval '7 days') THEN
      v_total := v_total + _integrity_signal('attestation_failed', 40, r.user_id, NULL, p_match,
        '{}'::jsonb, 'attestation_in_match:' || p_match || ':' || r.user_id);
    END IF;
  END LOOP;

  v_total := least(100, v_total);
  IF v_total >= v_flag THEN
    UPDATE integrity_signals SET flagged = true WHERE match_id = p_match AND status = 'open';
  END IF;
  RETURN v_total;
END;
$$;

-- The device check failed (or was not good enough) when someone entered Pool. A signal with no match.
CREATE FUNCTION integrity_record_attestation_failure(p_user uuid, p_platform text, p_reason text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  PERFORM _integrity_signal('attestation_failed', 40, p_user, NULL, NULL,
    jsonb_build_object('platform', left(coalesce(p_platform, ''), 12), 'reason', left(coalesce(p_reason, ''), 60)),
    'attestation:' || p_user || ':' || (now() AT TIME ZONE 'Africa/Lagos')::date);
END;
$$;

-- What every settle path calls instead of `settle_match`. For a Free match, and a Pool match nobody is suspicious
-- of, it is exactly `settle_match`. For a suspicious Pool match it records the hold and stops: placements stay
-- as the caller set them, the escrow stays open, `matches.status` becomes 'disputed' until a person decides.
-- Calling it again for a held match changes nothing (so a retried final move is safe).
CREATE FUNCTION settle_or_hold(p_match uuid) RETURNS ledger_result
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m matches;
  v_esc text;
  v_total int;
  v_hold uuid;
  p record;
BEGIN
  SELECT * INTO m FROM matches WHERE id = p_match FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:match_not_found'; END IF;

  IF m.mode = 'pool' THEN
    IF EXISTS (SELECT 1 FROM integrity_holds WHERE match_id = p_match AND status = 'held') THEN
      RETURN (NULL::uuid, false);
    END IF;
    SELECT status::text INTO v_esc FROM pool_escrows WHERE match_id = p_match;
    IF v_esc = 'open' AND NOT EXISTS (SELECT 1 FROM integrity_holds WHERE match_id = p_match) THEN
      v_total := integrity_evaluate_match(p_match);
      IF v_total >= cfg_bigint('integrity_hold_threshold', 70) THEN
        INSERT INTO integrity_holds (match_id, total_score, lapses_at)
        VALUES (p_match, v_total, now() + make_interval(hours => cfg_bigint('integrity_hold_max_hours', 72)::int))
        RETURNING id INTO v_hold;
        UPDATE matches SET status = 'disputed', finished_at = coalesce(finished_at, now()),
                           current_turn = NULL, turn_deadline = NULL
         WHERE id = p_match;
        FOR p IN SELECT user_id FROM match_players WHERE match_id = p_match AND staked_kobo > 0 LOOP
          PERFORM _notify(p.user_id, 'moderation_notice', NULL,
            jsonb_build_object('kind', 'payout_review', 'matchId', p_match, 'gameSlug', m.game_slug),
            'hold:' || p_match);
        END LOOP;
        RETURN (NULL::uuid, false);
      END IF;
    END IF;
  END IF;
  RETURN settle_match(p_match);
END;
$$;

-- A person decides a held payout. 'release': pay as the match was decided. 'void': give every stake back.
-- 'disqualify': the named player is placed last and loses, everyone else is ranked as before, then pay.
-- Idempotent for the same decision; a different decision on a decided hold is `hold_resolved`.
CREATE FUNCTION resolve_integrity_hold(
  p_hold uuid, p_decision text, p_admin text, p_note text, p_user uuid DEFAULT NULL
) RETURNS ledger_result
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  h integrity_holds;
  m matches;
  res ledger_result;
  v_status text;
  v_forfeits uuid[];
  v_last int;
BEGIN
  IF p_admin IS NULL OR btrim(p_admin) = '' THEN RAISE EXCEPTION 'dyce:admin_required'; END IF;
  IF p_decision NOT IN ('release', 'void', 'disqualify') THEN RAISE EXCEPTION 'dyce:invalid_decision'; END IF;
  v_status := CASE p_decision WHEN 'release' THEN 'released' WHEN 'void' THEN 'voided' ELSE 'disqualified' END;

  SELECT * INTO h FROM integrity_holds WHERE id = p_hold;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:hold_not_found'; END IF;
  -- same lock order as settle_or_hold: the match first
  SELECT * INTO m FROM matches WHERE id = h.match_id FOR UPDATE;
  SELECT * INTO h FROM integrity_holds WHERE id = p_hold FOR UPDATE;
  IF h.status <> 'held' THEN
    IF h.status = v_status AND h.disqualified_user IS NOT DISTINCT FROM p_user THEN
      RETURN (h.resolution_txn, true);
    END IF;
    RAISE EXCEPTION 'dyce:hold_resolved';
  END IF;

  SELECT array_agg(user_id) INTO v_forfeits FROM match_players WHERE match_id = h.match_id AND result = 'forfeit';

  IF p_decision = 'release' THEN
    res := settle_match(h.match_id);
  ELSIF p_decision = 'void' THEN
    res := refund_match(h.match_id, 'cancelled');
    UPDATE match_players SET result = NULL, placement = NULL WHERE match_id = h.match_id;
  ELSE
    IF p_user IS NULL OR NOT EXISTS (
      SELECT 1 FROM match_players WHERE match_id = h.match_id AND user_id = p_user AND staked_kobo > 0
    ) THEN RAISE EXCEPTION 'dyce:not_a_player'; END IF;
    UPDATE match_players mp SET placement = r.rk
      FROM (SELECT user_id, dense_rank() OVER (ORDER BY placement) AS rk
              FROM match_players
             WHERE match_id = h.match_id AND staked_kobo > 0 AND user_id <> p_user) r
     WHERE mp.match_id = h.match_id AND mp.user_id = r.user_id;
    SELECT coalesce(max(placement), 0) + 1 INTO v_last
      FROM match_players WHERE match_id = h.match_id AND staked_kobo > 0 AND user_id <> p_user;
    UPDATE match_players SET placement = v_last WHERE match_id = h.match_id AND user_id = p_user;
    res := settle_match(h.match_id);
    v_forfeits := array_append(coalesce(v_forfeits, '{}'), p_user);
  END IF;
  -- settle_match rewrites staked players' results to win/loss/draw: put the forfeits back.
  IF p_decision <> 'void' AND v_forfeits IS NOT NULL THEN
    UPDATE match_players SET result = 'forfeit' WHERE match_id = h.match_id AND user_id = ANY(v_forfeits);
  END IF;

  UPDATE integrity_holds
     SET status = v_status, decided_at = now(), decided_by = p_admin, decision_note = p_note,
         disqualified_user = CASE WHEN p_decision = 'disqualify' THEN p_user END, resolution_txn = res.txn_id
   WHERE id = p_hold;
  UPDATE integrity_signals
     SET status = CASE WHEN p_decision = 'release' THEN 'dismissed' ELSE 'actioned' END,
         reviewed_by = p_admin, reviewed_at = now()
   WHERE match_id = h.match_id AND status IN ('open', 'reviewing');
  PERFORM _moderation_log(p_admin, 'hold_' || p_decision, p_user, p_note,
    jsonb_build_object('matchId', h.match_id, 'txn', res.txn_id), NULL, NULL, p_hold);
  RETURN res;
END;
$$;

-- A hold nobody decided pays out as originally decided once its time is up (the job runs every few minutes).
CREATE FUNCTION integrity_lapse_holds() RETURNS int
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  h record;
  n int := 0;
BEGIN
  FOR h IN SELECT id FROM integrity_holds WHERE status = 'held' AND lapses_at <= now() ORDER BY lapses_at LOOP
    PERFORM resolve_integrity_hold(h.id, 'release', 'system:lapse', 'no decision before the hold lapsed');
    n := n + 1;
  END LOOP;
  RETURN n;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- sanctions and reports
-- ---------------------------------------------------------------------------------------------

CREATE FUNCTION moderation_sanction(
  p_user uuid, p_kind text, p_admin text, p_note text, p_hours int DEFAULT NULL,
  p_report uuid DEFAULT NULL, p_signal uuid DEFAULT NULL
) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_id uuid;
  v_until timestamptz;
  v_froze boolean := false;
BEGIN
  IF p_admin IS NULL OR btrim(p_admin) = '' THEN RAISE EXCEPTION 'dyce:admin_required'; END IF;
  IF p_kind NOT IN ('warning', 'mute', 'suspension') THEN RAISE EXCEPTION 'dyce:invalid_decision'; END IF;
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user) THEN RAISE EXCEPTION 'dyce:user_not_found'; END IF;
  IF p_hours IS NOT NULL AND (p_hours < 1 OR p_hours > 24 * 365) THEN RAISE EXCEPTION 'dyce:invalid_duration'; END IF;

  IF p_kind = 'mute' THEN
    v_until := now() + make_interval(hours => coalesce(p_hours, 24 * 7));
  ELSIF p_kind = 'suspension' AND p_hours IS NOT NULL THEN
    v_until := now() + make_interval(hours => p_hours);
  END IF;

  IF p_kind = 'suspension' THEN
    SELECT NOT pool_frozen INTO v_froze FROM profiles WHERE id = p_user;
  END IF;

  INSERT INTO user_sanctions (user_id, kind, report_id, signal_id, note, created_by, expires_at, froze_pool)
  VALUES (p_user, p_kind, p_report, p_signal, p_note, p_admin, v_until, coalesce(v_froze, false))
  RETURNING id INTO v_id;

  IF p_kind = 'mute' THEN
    UPDATE users SET muted_until = greatest(coalesce(muted_until, v_until), v_until) WHERE id = p_user;
  ELSIF p_kind = 'suspension' THEN
    -- 'infinity' = until a moderator lifts it
    UPDATE users SET suspended_until = CASE
      WHEN v_until IS NULL OR suspended_until = 'infinity' THEN 'infinity'::timestamptz
      ELSE greatest(coalesce(suspended_until, v_until), v_until) END
     WHERE id = p_user;
    UPDATE profiles SET pool_frozen = true WHERE id = p_user;
    UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = p_user;
  ELSE
    PERFORM _notify(p_user, 'moderation_notice', NULL, jsonb_build_object('kind', 'warning'), 'san:' || v_id);
  END IF;
  IF p_kind = 'mute' THEN
    PERFORM _notify(p_user, 'moderation_notice', NULL,
      jsonb_build_object('kind', 'mute', 'until', v_until), 'san:' || v_id);
  END IF;

  PERFORM _moderation_log(p_admin, 'sanction_' || p_kind, p_user, p_note,
    jsonb_build_object('hours', p_hours, 'until', v_until), p_report, p_signal, NULL, NULL, v_id);
  RETURN v_id;
END;
$$;

CREATE FUNCTION moderation_lift_sanction(p_sanction uuid, p_admin text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s user_sanctions;
BEGIN
  IF p_admin IS NULL OR btrim(p_admin) = '' THEN RAISE EXCEPTION 'dyce:admin_required'; END IF;
  SELECT * INTO s FROM user_sanctions WHERE id = p_sanction FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:sanction_not_found'; END IF;
  IF s.lifted_at IS NOT NULL THEN RETURN; END IF;
  UPDATE user_sanctions SET lifted_at = now(), lifted_by = p_admin WHERE id = p_sanction;

  UPDATE users u SET
    muted_until = (SELECT max(coalesce(x.expires_at, 'infinity'::timestamptz)) FROM user_sanctions x
                    WHERE x.user_id = u.id AND x.kind = 'mute' AND x.lifted_at IS NULL
                      AND (x.expires_at IS NULL OR x.expires_at > now())),
    suspended_until = (SELECT max(coalesce(x.expires_at, 'infinity'::timestamptz)) FROM user_sanctions x
                        WHERE x.user_id = u.id AND x.kind = 'suspension' AND x.lifted_at IS NULL
                          AND (x.expires_at IS NULL OR x.expires_at > now()))
   WHERE u.id = s.user_id;
  IF s.kind = 'suspension' AND s.froze_pool AND NOT EXISTS (
    SELECT 1 FROM users WHERE id = s.user_id AND suspended_until > now()
  ) THEN
    UPDATE profiles SET pool_frozen = false WHERE id = s.user_id;
  END IF;
  PERFORM _moderation_log(p_admin, 'sanction_lifted', s.user_id, p_note, '{}'::jsonb, NULL, NULL, NULL, NULL, p_sanction);
END;
$$;

-- Acts on a report. 'review' marks it as being looked at; 'warn' / 'mute' / 'suspend' sanction the reported person;
-- 'dismiss' closes it. A closed report tells the reporter once, in words that never say what was done.
CREATE FUNCTION moderation_act_on_report(
  p_report uuid, p_action text, p_admin text, p_note text, p_hours int DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  r reports;
  v_san uuid;
  v_outcome text;
BEGIN
  IF p_admin IS NULL OR btrim(p_admin) = '' THEN RAISE EXCEPTION 'dyce:admin_required'; END IF;
  IF p_action NOT IN ('review', 'warn', 'mute', 'suspend', 'dismiss') THEN RAISE EXCEPTION 'dyce:invalid_decision'; END IF;
  SELECT * INTO r FROM reports WHERE id = p_report FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:report_not_found'; END IF;
  IF r.status IN ('actioned', 'dismissed') THEN RAISE EXCEPTION 'dyce:report_resolved'; END IF;

  IF p_action = 'review' THEN
    UPDATE reports SET status = 'reviewing', reviewed_by = p_admin, reviewed_at = coalesce(reviewed_at, now())
     WHERE id = p_report;
    PERFORM _moderation_log(p_admin, 'report_review', r.target_user_id, p_note, '{}'::jsonb, p_report);
    RETURN;
  END IF;

  IF p_action = 'dismiss' THEN
    v_outcome := 'dismissed';
  ELSE
    IF r.target_user_id IS NULL THEN RAISE EXCEPTION 'dyce:user_not_found'; END IF;
    v_san := moderation_sanction(
      r.target_user_id,
      CASE p_action WHEN 'warn' THEN 'warning' WHEN 'mute' THEN 'mute' ELSE 'suspension' END,
      p_admin, p_note, p_hours, p_report, NULL);
    v_outcome := CASE p_action WHEN 'warn' THEN 'warned' WHEN 'mute' THEN 'muted' ELSE 'suspended' END;
  END IF;

  UPDATE reports
     SET status = CASE WHEN p_action = 'dismiss' THEN 'dismissed'::report_status ELSE 'actioned'::report_status END,
         outcome = v_outcome, reviewed_by = p_admin, reviewed_at = now(), decision_note = p_note,
         reporter_notified_at = now()
   WHERE id = p_report;
  -- the reporter hears that it was looked at, never what was done
  PERFORM _notify(r.reporter_id, 'report_outcome', NULL,
    jsonb_build_object('outcome', CASE WHEN p_action = 'dismiss' THEN 'dismissed' ELSE 'actioned' END),
    'rep:' || p_report);
  PERFORM _moderation_log(p_admin, 'report_' || p_action, r.target_user_id, p_note,
    jsonb_build_object('hours', p_hours), p_report, NULL, NULL, NULL, v_san);
END;
$$;

CREATE FUNCTION moderation_review_signal(p_signal uuid, p_status text, p_admin text, p_note text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE s integrity_signals;
BEGIN
  IF p_admin IS NULL OR btrim(p_admin) = '' THEN RAISE EXCEPTION 'dyce:admin_required'; END IF;
  IF p_status NOT IN ('reviewing', 'actioned', 'dismissed') THEN RAISE EXCEPTION 'dyce:invalid_decision'; END IF;
  SELECT * INTO s FROM integrity_signals WHERE id = p_signal FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:signal_not_found'; END IF;
  UPDATE integrity_signals SET status = p_status, reviewed_by = p_admin, reviewed_at = now(), review_note = p_note
   WHERE id = p_signal;
  PERFORM _moderation_log(p_admin, 'signal_' || p_status, s.subject_user, p_note, '{}'::jsonb, NULL, p_signal);
END;
$$;

-- resolve_dispute (0023) with an audit row. 'reversed' still needs the reversal an admin posted by hand (ADR-037).
CREATE FUNCTION moderation_resolve_dispute(
  p_dispute uuid, p_status dispute_status, p_note text, p_admin text, p_txn uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE d disputes;
BEGIN
  IF p_admin IS NULL OR btrim(p_admin) = '' THEN RAISE EXCEPTION 'dyce:admin_required'; END IF;
  SELECT * INTO d FROM disputes WHERE id = p_dispute;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:dispute_not_found'; END IF;
  -- resolve_dispute records a reviewer id; moderators here are named by text, so it gets NULL
  PERFORM resolve_dispute(p_dispute, p_status, p_note, NULL, p_txn);
  PERFORM _moderation_log(p_admin, 'dispute_' || p_status::text, d.user_id, p_note,
    jsonb_build_object('txn', p_txn), NULL, NULL, NULL, p_dispute);
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- what moderators read (views: the admin role has no table access)
-- ---------------------------------------------------------------------------------------------

CREATE VIEW moderation_report_queue AS
SELECT r.id, r.status, r.reason, r.note, r.created_at, r.reviewed_by, r.reviewed_at, r.outcome, r.decision_note,
       r.reporter_id, rp.username AS reporter, r.target_user_id, tp.username AS target,
       r.conversation_id, r.message_id, r.evidence,
       (SELECT count(*) FROM reports o WHERE o.target_user_id = r.target_user_id AND o.id <> r.id
           AND o.created_at >= now() - interval '90 days') AS other_reports_90d,
       (SELECT count(*) FROM user_sanctions s WHERE s.user_id = r.target_user_id) AS prior_sanctions
  FROM reports r
  LEFT JOIN profiles rp ON rp.id = r.reporter_id
  LEFT JOIN profiles tp ON tp.id = r.target_user_id
 ORDER BY (r.status IN ('actioned', 'dismissed')), r.created_at;

CREATE VIEW moderation_signal_queue AS
SELECT s.id, s.kind, s.score, s.status, s.flagged, s.created_at, s.match_id, s.detail,
       s.reviewed_by, s.reviewed_at, s.review_note,
       s.subject_user, sp.username AS subject, s.other_user, op.username AS other
  FROM integrity_signals s
  LEFT JOIN profiles sp ON sp.id = s.subject_user
  LEFT JOIN profiles op ON op.id = s.other_user
 ORDER BY (s.status IN ('actioned', 'dismissed')), s.score DESC, s.created_at;

CREATE VIEW moderation_hold_queue AS
SELECT h.id, h.match_id, h.status, h.total_score, h.created_at, h.lapses_at, h.decided_at, h.decided_by,
       h.decision_note, h.disqualified_user,
       m.game_slug, m.finished_at,
       (SELECT coalesce(sum(mp.staked_kobo), 0) FROM match_players mp WHERE mp.match_id = m.id) AS pot_kobo,
       (SELECT jsonb_agg(jsonb_build_object('userId', mp.user_id, 'username', pr.username,
                'placement', mp.placement, 'stakedKobo', mp.staked_kobo, 'payoutKobo', mp.payout_kobo) ORDER BY mp.seat)
          FROM match_players mp JOIN profiles pr ON pr.id = mp.user_id WHERE mp.match_id = m.id) AS players,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'score', s.score, 'detail', s.detail)
                ORDER BY s.score DESC), '[]'::jsonb)
          FROM integrity_signals s WHERE s.match_id = m.id) AS signals,
       (SELECT count(*) FROM match_moves mv WHERE mv.match_id = m.id) AS moves
  FROM integrity_holds h JOIN matches m ON m.id = h.match_id
 ORDER BY (h.status <> 'held'), h.lapses_at;

CREATE VIEW moderation_audit AS
SELECT a.id, a.created_at, a.admin, a.action, a.target_user, tp.username AS target, a.report_id, a.signal_id,
       a.hold_id, a.dispute_id, a.sanction_id, a.note, a.meta
  FROM moderation_actions a LEFT JOIN profiles tp ON tp.id = a.target_user
 ORDER BY a.created_at DESC;

CREATE VIEW moderation_user_overview AS
SELECT u.id, p.username, p.display_name, u.created_at, u.disabled_at, u.muted_until, u.suspended_until,
       p.pool_frozen, p.is_adult,
       (SELECT count(*) FROM reports r WHERE r.target_user_id = u.id) AS reports_against,
       (SELECT count(*) FROM reports r WHERE r.reporter_id = u.id) AS reports_filed,
       (SELECT count(*) FROM integrity_signals s WHERE s.subject_user = u.id AND s.flagged) AS flagged_signals,
       (SELECT count(*) FROM match_players mp JOIN matches x ON x.id = mp.match_id
         WHERE mp.user_id = u.id AND x.mode = 'pool') AS pool_matches,
       (SELECT coalesce(jsonb_agg(jsonb_build_object('id', s.id, 'kind', s.kind, 'createdAt', s.created_at,
                'expiresAt', s.expires_at, 'liftedAt', s.lifted_at, 'by', s.created_by) ORDER BY s.created_at DESC), '[]'::jsonb)
          FROM user_sanctions s WHERE s.user_id = u.id) AS sanctions
  FROM users u JOIN profiles p ON p.id = u.id;

-- ---------------------------------------------------------------------------------------------
-- grants. New functions are executable by PUBLIC unless revoked (see 0023).
-- ---------------------------------------------------------------------------------------------

REVOKE EXECUTE ON FUNCTION
  _trg_user_disabled_cleanup(), record_fingerprints(uuid, bytea, bytea), integrity_prune_fingerprints(),
  users_share_fingerprint(uuid, uuid),
  _trg_moderation_actions_immutable(),
  _moderation_log(text, text, uuid, text, jsonb, uuid, uuid, uuid, uuid, uuid),
  _integrity_signal(text, int, uuid, uuid, uuid, jsonb, text),
  integrity_evaluate_match(uuid), integrity_record_attestation_failure(uuid, text, text),
  settle_or_hold(uuid), resolve_integrity_hold(uuid, text, text, text, uuid), integrity_lapse_holds(),
  moderation_sanction(uuid, text, text, text, int, uuid, uuid), moderation_lift_sanction(uuid, text, text),
  moderation_act_on_report(uuid, text, text, text, int), moderation_review_signal(uuid, text, text, text),
  moderation_resolve_dispute(uuid, dispute_status, text, text, uuid)
FROM PUBLIC;

GRANT EXECUTE ON FUNCTION
  record_fingerprints(uuid, bytea, bytea), integrity_prune_fingerprints(), users_share_fingerprint(uuid, uuid),
  integrity_record_attestation_failure(uuid, text, text),
  settle_or_hold(uuid), integrity_lapse_holds()
TO dyce_api;

GRANT EXECUTE ON FUNCTION
  resolve_integrity_hold(uuid, text, text, text, uuid),
  moderation_sanction(uuid, text, text, text, int, uuid, uuid), moderation_lift_sanction(uuid, text, text),
  moderation_act_on_report(uuid, text, text, text, int), moderation_review_signal(uuid, text, text, text),
  moderation_resolve_dispute(uuid, dispute_status, text, text, uuid)
TO dyce_admin;

REVOKE ALL ON moderation_report_queue, moderation_signal_queue, moderation_hold_queue, moderation_audit,
  moderation_user_overview FROM PUBLIC, dyce_api;
GRANT SELECT ON moderation_report_queue, moderation_signal_queue, moderation_hold_queue, moderation_audit,
  moderation_user_overview, moderation_dispute_queue TO dyce_admin;
