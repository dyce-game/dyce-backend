-- Edge flows (ADR-037): Pool disputes, account deletion, and the config they need.
-- Resigning a match and the data export need no schema (service code over existing tables).
--
-- Money: nothing here moves money except `anonymise_account`, which clears the person's (virtual) balance with
-- one balanced 'adjust' transaction against the system_adjust account, after refunding any open Pool stakes.
-- Disputes never move money by themselves (ADR-037): a moderator resolves them, and a reversal is a separate,
-- admin-only `reverse_txn` whose id is recorded on the dispute.

INSERT INTO app_config (key, value) VALUES
  ('dispute_window_hours',        '24'),
  ('account_deletion_grace_days', '30'),
  ('disputes_per_day',            '5')
ON CONFLICT (key) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- disputes (the table exists since 0004; this makes it usable)
-- ---------------------------------------------------------------------------------------------

ALTER TABLE disputes
  ADD COLUMN reference     text NOT NULL
    DEFAULT ('DY-DSP-' || upper(substr(md5(random()::text || clock_timestamp()::text), 1, 6))),
  ADD COLUMN decision_note text,
  ADD COLUMN reviewing_at  timestamptz,
  ADD COLUMN reviewer_id   uuid REFERENCES users(id);

CREATE UNIQUE INDEX disputes_reference_key ON disputes (reference);
CREATE INDEX disputes_queue_idx ON disputes (status, created_at) WHERE resolved_at IS NULL;
CREATE INDEX disputes_user_idx ON disputes (user_id, created_at DESC);

ALTER TABLE disputes
  ADD CONSTRAINT disputes_reason_chk CHECK (reason IN ('cheat', 'glitch', 'score', 'disconnect', 'other')),
  ADD CONSTRAINT disputes_note_len_chk CHECK (note IS NULL OR char_length(note) <= 500),
  ADD CONSTRAINT disputes_decision_len_chk CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
  -- 'upheld' = the original result stands; 'reversed' = the result was corrected with a reversing transaction
  ADD CONSTRAINT disputes_resolution_chk CHECK (
    (status IN ('open', 'reviewing') AND resolved_at IS NULL)
    OR (status = 'upheld' AND resolved_at IS NOT NULL)
    OR (status = 'reversed' AND resolved_at IS NOT NULL AND resolution_txn IS NOT NULL)
  );

-- The moderator-side table: what a person needs to decide a dispute, oldest open first. Admin tooling reads it;
-- the API role cannot (it never lists other people's disputes).
CREATE VIEW moderation_dispute_queue AS
SELECT d.id, d.reference, d.status, d.reason, d.note, d.created_at, d.reviewing_at, d.resolved_at,
       d.decision_note, d.resolution_txn,
       m.id AS match_id, m.game_slug, m.mode, m.finished_at,
       (SELECT coalesce(sum(mp.staked_kobo), 0) FROM match_players mp WHERE mp.match_id = m.id) AS pot_kobo,
       disputer.username AS disputer,
       (SELECT string_agg(pr.username, ', ' ORDER BY mp.seat)
          FROM match_players mp JOIN profiles pr ON pr.id = mp.user_id
         WHERE mp.match_id = m.id AND mp.user_id <> d.user_id) AS opponents,
       (SELECT count(*) FROM match_moves mv WHERE mv.match_id = m.id) AS moves
  FROM disputes d
  JOIN matches m ON m.id = d.match_id
  JOIN profiles disputer ON disputer.id = d.user_id
 ORDER BY (d.resolved_at IS NOT NULL), d.created_at;
REVOKE ALL ON moderation_dispute_queue FROM PUBLIC, dyce_api;

-- Admin tooling only (not granted to dyce_api): move a dispute along. 'reversed' needs the reversing
-- transaction the admin posted with reverse_txn (kind 'reversal'). Idempotent for the same status.
CREATE FUNCTION resolve_dispute(
  p_dispute uuid, p_status dispute_status, p_note text, p_admin uuid, p_txn uuid DEFAULT NULL
) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d disputes;
BEGIN
  SELECT * INTO d FROM disputes WHERE id = p_dispute FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:dispute_not_found'; END IF;
  IF d.status = p_status AND d.status IN ('upheld', 'reversed') THEN RETURN; END IF;
  IF d.resolved_at IS NOT NULL THEN RAISE EXCEPTION 'dyce:dispute_resolved'; END IF;
  IF p_status = 'open' THEN RAISE EXCEPTION 'dyce:invalid_dispute_status'; END IF;
  IF p_status = 'reviewing' THEN
    UPDATE disputes SET status = 'reviewing', reviewing_at = coalesce(reviewing_at, now()), reviewer_id = p_admin
     WHERE id = p_dispute;
    RETURN;
  END IF;
  IF p_status = 'reversed' AND NOT EXISTS (SELECT 1 FROM ledger_txns WHERE id = p_txn AND kind = 'reversal') THEN
    RAISE EXCEPTION 'dyce:reversal_required';
  END IF;
  UPDATE disputes
     SET status = p_status, decision_note = p_note, resolution_txn = p_txn, reviewer_id = p_admin,
         reviewing_at = coalesce(reviewing_at, now()), resolved_at = now()
   WHERE id = p_dispute;
END;
$$;

-- ---------------------------------------------------------------------------------------------
-- account deletion (SPEC section 12: balance cleared, games history anonymised)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE account_deletions (
  user_id        uuid PRIMARY KEY REFERENCES users(id),
  requested_at   timestamptz NOT NULL DEFAULT now(),
  -- signing back in before this moment cancels the request (the grace period of the Delete account design)
  execute_after  timestamptz NOT NULL,
  cancelled_at   timestamptz,
  completed_at   timestamptz,
  attempts       int NOT NULL DEFAULT 0,
  last_note      text
);
CREATE INDEX account_deletions_due_idx ON account_deletions (execute_after)
  WHERE completed_at IS NULL AND cancelled_at IS NULL;
-- The API reads the request (settings screen); only the functions below change it.
GRANT SELECT ON account_deletions TO dyce_api;

-- Ask to delete. Starts the grace period and ends every session. Asking again while a request is pending keeps the
-- original date (a retry never extends the wait); asking after cancelling starts a new one.
CREATE FUNCTION request_account_deletion(p_user uuid) RETURNS timestamptz
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  v_days bigint := cfg_bigint('account_deletion_grace_days', 30);
  v_after timestamptz;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM users WHERE id = p_user AND disabled_at IS NULL) THEN
    RAISE EXCEPTION 'dyce:account_deleted';
  END IF;
  INSERT INTO account_deletions (user_id, execute_after)
  VALUES (p_user, now() + make_interval(days => v_days::int))
  ON CONFLICT (user_id) DO UPDATE
     SET requested_at = now(), execute_after = EXCLUDED.execute_after, cancelled_at = NULL, attempts = 0
   WHERE account_deletions.completed_at IS NULL AND account_deletions.cancelled_at IS NOT NULL;
  SELECT execute_after INTO v_after FROM account_deletions WHERE user_id = p_user;
  UPDATE refresh_tokens SET revoked_at = coalesce(revoked_at, now()) WHERE user_id = p_user;
  RETURN v_after;
END;
$$;

-- Change of mind. True when a pending request was cancelled. Called when the person signs back in.
CREATE FUNCTION cancel_account_deletion(p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  UPDATE account_deletions SET cancelled_at = now()
   WHERE user_id = p_user AND completed_at IS NULL AND cancelled_at IS NULL;
  RETURN FOUND;
END;
$$;

-- Does the deletion. Idempotent: a second call after it finished does nothing and says so. Returns false (and
-- changes nothing) while the person still sits in a space, because leaving a space is the Spaces service's job
-- (host hand-over, refunds); the service leaves waiting spaces first and a live one just has to finish.
-- Order matters: open matches are cancelled and refunded before the balance is cleared, so a Pool stake that was
-- in escrow is cleared with the rest and the ledger stays balanced.
CREATE FUNCTION anonymise_account(p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d account_deletions;
  r record;
  v_old bytea;
  v_balance bigint;
BEGIN
  SELECT * INTO d FROM account_deletions WHERE user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:no_deletion_request'; END IF;
  IF d.completed_at IS NOT NULL THEN RETURN true; END IF;
  IF d.cancelled_at IS NOT NULL THEN RAISE EXCEPTION 'dyce:deletion_cancelled'; END IF;

  IF EXISTS (SELECT 1 FROM space_members sm JOIN spaces s ON s.id = sm.space_id
              WHERE sm.user_id = p_user AND sm.left_at IS NULL AND s.status IN ('waiting', 'live')) THEN
    UPDATE account_deletions SET attempts = attempts + 1, last_note = 'still in a space' WHERE user_id = p_user;
    RETURN false;
  END IF;

  -- open games: cancel them; Pool stakes (both players') go back first
  FOR r IN
    SELECT m.id, m.mode FROM matches m JOIN match_players mp ON mp.match_id = m.id
     WHERE mp.user_id = p_user AND m.status IN ('invited', 'countered', 'active') AND m.space_id IS NULL
     ORDER BY m.id
  LOOP
    IF r.mode = 'pool' THEN
      PERFORM refund_match(r.id, 'cancelled');
    ELSE
      UPDATE matches SET status = 'cancelled', finished_at = coalesce(finished_at, now()) WHERE id = r.id;
    END IF;
  END LOOP;

  -- money requests that are still open
  FOR r IN SELECT code FROM payment_requests WHERE requester = p_user AND status = 'open' LOOP
    PERFORM cancel_payment_request(r.code, p_user);
  END LOOP;

  -- the balance goes to zero (it was virtual: nothing is paid out)
  PERFORM 1 FROM wallets WHERE user_id = p_user FOR UPDATE;
  SELECT balance_kobo INTO v_balance FROM wallets WHERE user_id = p_user;
  IF coalesce(v_balance, 0) > 0 THEN
    PERFORM _ledger_post(
      'adjust', 'account_delete:' || p_user, NULL,
      jsonb_build_object('reason', 'account_deleted', 'user_id', p_user),
      jsonb_build_array(
        jsonb_build_object('account', _wallet_account(p_user), 'amount', -v_balance),
        jsonb_build_object('account', _system_account('system_adjust'), 'amount', v_balance)
      )
    );
  END IF;

  -- the person: free the number and the name, drop everything personal that is not history
  SELECT phone_hash INTO v_old FROM users WHERE id = p_user;
  DELETE FROM otp_challenges WHERE phone_hash = v_old;
  DELETE FROM sms_invites WHERE phone_hash = v_old OR inviter_id = p_user;
  UPDATE users
     SET disabled_at = coalesce(disabled_at, now()),
         phone_hash = decode(md5('deleted:' || p_user::text || random()::text), 'hex')
   WHERE id = p_user;
  UPDATE profiles
     SET username = 'deleted_' || substr(md5(p_user::text), 1, 8), display_name = 'Deleted player',
         avatar = '{}'::jsonb, birth_year = NULL, city = NULL, is_adult = false, show_online = false,
         request_policy = 'nobody', level = 1, xp = 0, last_seen_at = NULL
   WHERE id = p_user;
  DELETE FROM refresh_tokens WHERE user_id = p_user;
  DELETE FROM push_tokens WHERE user_id = p_user;
  DELETE FROM contact_links WHERE owner_id = p_user OR contact_user_id = p_user;
  DELETE FROM contact_lookups WHERE user_id = p_user;
  DELETE FROM friendships WHERE user_low = p_user OR user_high = p_user;
  DELETE FROM blocks WHERE blocker_id = p_user OR blocked_id = p_user;
  DELETE FROM notifications WHERE user_id = p_user;
  DELETE FROM notification_prefs WHERE user_id = p_user;
  DELETE FROM search_usage WHERE user_id = p_user;
  DELETE FROM quick_match_tickets WHERE user_id = p_user;
  DELETE FROM xp_events WHERE user_id = p_user;
  DELETE FROM streaks WHERE user_id = p_user;
  DELETE FROM user_badges WHERE user_id = p_user;

  UPDATE account_deletions SET completed_at = now(), last_note = NULL WHERE user_id = p_user;
  RETURN true;
END;
$$;

-- Who is due, oldest first. A plain read so the service can loop with its own error handling per person.
CREATE FUNCTION due_account_deletions(p_limit int DEFAULT 50) RETURNS SETOF uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
  SELECT user_id FROM account_deletions
   WHERE completed_at IS NULL AND cancelled_at IS NULL AND execute_after <= now()
   ORDER BY execute_after LIMIT p_limit;
$$;

-- New functions are executable by PUBLIC unless that is revoked (0006 only covered the functions that existed then).
REVOKE EXECUTE ON FUNCTION
  resolve_dispute(uuid, dispute_status, text, uuid, uuid),
  request_account_deletion(uuid),
  cancel_account_deletion(uuid),
  anonymise_account(uuid),
  due_account_deletions(int)
FROM PUBLIC;
GRANT EXECUTE ON FUNCTION
  request_account_deletion(uuid),
  cancel_account_deletion(uuid),
  anonymise_account(uuid),
  due_account_deletions(int)
TO dyce_api;
-- resolve_dispute is admin tooling: intentionally NOT granted to dyce_api.
