-- Live Spaces: private rooms (friends or code) that play one live match, Whot! first (ADR-018).
--
-- A space owns one `matches` row for its current round. The match is created with the space (status
-- 'invited' = "waiting for players"), every seat that joins is a `match_players` row, and in Pool each
-- seat fee is escrowed when the person sits down (stake_pool), so the match always holds exactly the
-- money of the people seated. Starting the space initialises the engine and turns the match 'active'; the
-- game server then runs it and settles through settle_match. Money moves only through SQL functions.

ALTER TABLE spaces
  ADD COLUMN started_at timestamptz,
  ADD COLUMN ended_at timestamptz;

-- A person who leaves and sits down again pays again: the stake key carries this counter.
ALTER TABLE space_members ADD COLUMN join_n int NOT NULL DEFAULT 1;
CREATE INDEX space_members_user_idx ON space_members (user_id) WHERE left_at IS NULL;
CREATE INDEX matches_space_idx ON matches (space_id, created_at DESC) WHERE space_id IS NOT NULL;

-- Room-level facts the engine does not know about (who forfeited and when). The engine state itself stays
-- in matches.state; live matches are never sent to a client except through the engine's view().
ALTER TABLE matches ADD COLUMN live_meta jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Whot! is the first live game. 2-4 seats in Spaces (the engine supports 6; more seats come with 3D).
INSERT INTO games (slug, name, dimension, sync, min_players, max_players, categories, supports_pool, enabled)
VALUES ('whot', 'Whot!', '2d', 'live', 2, 4, '{cards}', true, true)
ON CONFLICT (slug) DO UPDATE
  SET sync = 'live', min_players = 2, max_players = 4, supports_pool = true, enabled = true;

INSERT INTO app_config (key, value) VALUES
  ('space_waiting_ttl_hours', '6'),
  ('spaces_open_per_user', '5')
ON CONFLICT (key) DO NOTHING;

-- Give one player's stake back before the match has started (they left or were removed from a waiting
-- space). Lock order matches stake_pool / settle_match: match row, wallets, escrow. Idempotent on p_idem.
CREATE FUNCTION unstake_pool(p_match uuid, p_user uuid, p_idem text)
RETURNS ledger_result
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
DECLARE
  m matches;
  v_player match_players;
  v_escrow uuid;
  res ledger_result;
BEGIN
  IF _replay(p_idem) IS NOT NULL THEN RETURN (_replay(p_idem), true); END IF;

  SELECT * INTO m FROM matches WHERE id = p_match FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:match_not_found'; END IF;
  IF m.mode <> 'pool' THEN RAISE EXCEPTION 'dyce:not_a_pool_match'; END IF;
  IF m.status <> 'invited' THEN RAISE EXCEPTION 'dyce:match_closed'; END IF;

  PERFORM 1 FROM wallets
    WHERE user_id IN (SELECT user_id FROM match_players WHERE match_id = p_match)
    ORDER BY user_id FOR UPDATE;

  SELECT * INTO v_player FROM match_players WHERE match_id = p_match AND user_id = p_user FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'dyce:not_a_player'; END IF;
  IF v_player.staked_kobo = 0 THEN RETURN (NULL::uuid, false); END IF;

  SELECT account_id INTO v_escrow FROM pool_escrows WHERE match_id = p_match AND status = 'open';
  IF v_escrow IS NULL THEN RAISE EXCEPTION 'dyce:match_closed'; END IF;

  res := _ledger_post(
    'refund', p_idem, p_user,
    jsonb_build_object('match_id', p_match, 'user', p_user, 'unstake_kobo', v_player.staked_kobo),
    jsonb_build_array(
      jsonb_build_object('account', v_escrow, 'amount', -v_player.staked_kobo),
      jsonb_build_object('account', _wallet_account(p_user), 'amount', v_player.staked_kobo)
    )
  );
  UPDATE match_players SET staked_kobo = 0 WHERE match_id = p_match AND user_id = p_user;
  RETURN res;
END;
$$;

REVOKE EXECUTE ON FUNCTION unstake_pool(uuid, uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION unstake_pool(uuid, uuid, text) TO dyce_api;
