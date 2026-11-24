-- Email as a way in (ADR-044): sign up and log in with an address verified by a one-time code, like the phone.
--
-- Identity model: a person has a phone, an email, or both. Neither is stored in the clear:
--   users.phone_hash   HMAC of the E.164 number (unchanged)
--   users.email_hash   HMAC of the normalised address, domain-separated from the phone hash and the OTP hash
--   users.email_hint   a masked form ("t******@gmail.com") so Settings can say which address is linked
-- A code is only ever sent to an address the person has just typed, so Dyce never needs the plain address again.
-- The CHECK keeps the invariant that matters: no account without a way back in.

ALTER TABLE users ALTER COLUMN phone_hash DROP NOT NULL;
ALTER TABLE users
  ADD COLUMN email_hash         bytea UNIQUE,
  ADD COLUMN email_hint         text,
  ADD COLUMN email_verified_at  timestamptz;
ALTER TABLE users ADD CONSTRAINT users_identity_chk CHECK (phone_hash IS NOT NULL OR email_hash IS NOT NULL);
ALTER TABLE users ADD CONSTRAINT users_email_hint_chk CHECK ((email_hash IS NULL) = (email_hint IS NULL));

-- One-time codes: for a phone or for an email, never both and never neither.
ALTER TABLE otp_challenges ALTER COLUMN phone_hash DROP NOT NULL;
ALTER TABLE otp_challenges ADD COLUMN email_hash bytea;
ALTER TABLE otp_challenges ADD CONSTRAINT otp_challenges_one_identity_chk
  CHECK ((phone_hash IS NOT NULL) <> (email_hash IS NOT NULL));
CREATE INDEX otp_challenges_email_idx ON otp_challenges (email_hash, created_at DESC) WHERE email_hash IS NOT NULL;

-- Deleting an account also frees its email (and forgets the hint), exactly as it frees the number.
CREATE OR REPLACE FUNCTION anonymise_account(p_user uuid) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  d account_deletions;
  r record;
  v_old bytea;
  v_old_email bytea;
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
  SELECT phone_hash, email_hash INTO v_old, v_old_email FROM users WHERE id = p_user;
  DELETE FROM otp_challenges WHERE phone_hash = v_old OR email_hash = v_old_email;
  DELETE FROM sms_invites WHERE phone_hash = v_old OR inviter_id = p_user;
  UPDATE users
     SET disabled_at = coalesce(disabled_at, now()),
         phone_hash = decode(md5('deleted:' || p_user::text || random()::text), 'hex'),
         email_hash = NULL, email_hint = NULL, email_verified_at = NULL
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
