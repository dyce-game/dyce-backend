-- Pool mode for async 1v1 matches (ADR-017).
--
-- Money still moves only through stake_pool / settle_match / refund_match (0005). This adds the one
-- movement a counter-offer needs: giving back part of the creator's escrowed stake.

-- The invite carries its counter-offer state: whether the invitee may counter, and the one counter they
-- made (0 = "play this one free").
ALTER TABLE matches
  ADD COLUMN allow_counter boolean NOT NULL DEFAULT true,
  ADD COLUMN counter_stake_kobo bigint CHECK (counter_stake_kobo IS NULL OR counter_stake_kobo >= 0);

-- Stake limits (docs/SPEC.md section 9: min ₦100, max ₦20,000 per game).
INSERT INTO app_config (key, value) VALUES
  ('pool_min_stake_kobo', '10000'),
  ('pool_max_stake_kobo', '2000000')
ON CONFLICT (key) DO NOTHING;

-- The reference game can be played for stakes outside production (it is dev-only in the registry), which is
-- what lets the whole Pool flow be exercised end to end.
UPDATE games SET supports_pool = true WHERE slug = '_example';

-- Reduce a player's escrowed stake on a countered invite. The difference goes back to their wallet in one
-- balanced transaction. Taking it to 0 turns the match into a Free one (nothing is left in escrow).
-- Lock order matches stake_pool: match row, wallets by user_id, escrow.
CREATE FUNCTION restake_pool(p_match uuid, p_user uuid, p_new_amount bigint, p_idem text)
RETURNS ledger_result
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m matches;
  v_player match_players;
  v_escrow uuid;
  v_diff bigint;
  res ledger_result;
BEGIN
  IF p_new_amount IS NULL OR p_new_amount < 0 THEN RAISE EXCEPTION 'dyce:invalid_amount'; END IF;

  SELECT * INTO m FROM matches WHERE id = p_match FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:match_not_found'; END IF;
  IF m.mode <> 'pool' THEN RAISE EXCEPTION 'dyce:not_a_pool_match'; END IF;

  -- A repeat of an applied adjustment is a no-op, whatever state the match has moved to since.
  IF _replay(p_idem) IS NOT NULL THEN RETURN (_replay(p_idem), true); END IF;
  IF m.status <> 'countered' THEN RAISE EXCEPTION 'dyce:match_closed'; END IF;

  PERFORM 1 FROM wallets
    WHERE user_id IN (SELECT user_id FROM match_players WHERE match_id = p_match)
    ORDER BY user_id FOR UPDATE;

  SELECT * INTO v_player FROM match_players WHERE match_id = p_match AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:not_a_player'; END IF;
  IF p_new_amount >= v_player.staked_kobo THEN RAISE EXCEPTION 'dyce:invalid_amount'; END IF;

  SELECT account_id INTO v_escrow FROM pool_escrows WHERE match_id = p_match AND status = 'open';
  IF v_escrow IS NULL THEN RAISE EXCEPTION 'dyce:match_closed'; END IF;

  v_diff := v_player.staked_kobo - p_new_amount;
  res := _ledger_post(
    'refund', p_idem, p_user,
    jsonb_build_object('match_id', p_match, 'user', p_user, 'restake_kobo', p_new_amount),
    jsonb_build_array(
      jsonb_build_object('account', v_escrow, 'amount', -v_diff),
      jsonb_build_object('account', _wallet_account(p_user), 'amount', v_diff)
    )
  );

  UPDATE match_players SET staked_kobo = p_new_amount WHERE match_id = p_match AND user_id = p_user;
  IF p_new_amount = 0 THEN
    UPDATE pool_escrows SET status = 'refunded' WHERE match_id = p_match;
    UPDATE matches SET mode = 'free', stake_kobo = 0 WHERE id = p_match;
  ELSE
    UPDATE matches SET stake_kobo = p_new_amount WHERE id = p_match;
  END IF;
  RETURN res;
END;
$$;

REVOKE EXECUTE ON FUNCTION restake_pool(uuid, uuid, bigint, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION restake_pool(uuid, uuid, bigint, text) TO dyce_api;
