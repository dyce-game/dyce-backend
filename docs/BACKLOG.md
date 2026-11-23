# Backlog (backend)

Product-level deferrals (tournaments, voice/video in Spaces, real-money anything, ...) are in `../Dyce/docs/BACKLOG.md`.

## Invites follow-ups (deferred from ADR-021)

- Real SMS delivery for invites has not been tried against Termii/Twilio (same adapters as OTP, ADR-007); the invite text may need a registered sender id and DND-route approval in Nigeria
- Resend and revoke a sent invite; delivery receipts feeding the status
- A push "your friend joined" for the inviter (needs push); today the new friend appears in Friends and the game card in the chat
- Guest play for Cup Pong (add an entry to `GUEST_GAMES` once its renderer runs in a browser without an account) and a rematch for guests
- Abuse: invite-by-number is a way to text strangers. Per-sender, per-number and cooldown limits exist; consider a per-IP guest-run cap and a report-this-invite path on the landing page
- Sweep job to delete expired, unjoined invites and their guest runs

## Spaces follow-ups (deferred from ADR-022)

- Public Spaces ("Open now" list, `visibility = 'public'`), "People" (Playing now / Near you / Top this week) on the Spaces tab
- Lobby chat, invite friends from the lobby (today: the code and a share link), a ready toggle, lock seats, host-passes-on notification, spectators
- Free spaces pay no XP yet (60 / 30 / 15 in the design); Spaces count toward streaks and badges when the progression work lands
- Replace a forfeited Free seat with a bot instead of auto-playing it (ARCHITECTURE option), Whot for 5 to 6 seats, rematch with the same seats ("Play again")
- Scale-out: Colyseus Redis presence and driver, sticky routing, a Redis bus for the `space` event; publish `space` events from the game server when a game ends so lobbies refresh without a refetch
- Push: "space starting" for seats who are not in the app (they get 90 s to show up before the seat forfeits)
- Collusion signals for Space pots are judged at settlement like any Pool match (ADR-039); what is left is a per-seat view for a moderator of who sat with whom

## Party rooms and quick match follow-ups (deferred from ADR-025)

- Quick match for the async games (Cup Pong, Word Hunt) and for Imposter-style groups: a stranger pair would need a match card without a chat; "Play again" with the same stranger; a push "match found" for someone who left the app (they have 10 s)
- Quick match collusion: done in ADR-039 (never pairs a shared device or IP in Pool; pair repeats, feeders and timing are judged at settlement); still open: bot and script detection beyond timing and repeated input, and learning from real data
- Bots: replace a forfeited seat in Free, and a bot opponent when nobody is found
- Table talk: not stored or moderated beyond a word list; report a line; mute a seat; a lobby chat before the game
- Spectating a game you are not in (nothing in the designs asks for it); dead Werewolf players are the only spectators
- Doodle canvas: a smarter diff (simplified paths) if `kbPerClientSecond` matters on 3G; a second streamed part for another game is a registry entry
- The clock restarts a phase from its last saved moment after a game-server restart (generous to players); a real restart soak with real timers
- Crazy Cards for 5 to 6 seats (engine supports 6) with the 3D table; Charades teams of 3 and 4 in the lobby
- Scale-out: Redis presence and driver for more than one game-server process (as for Whot!), a Redis bus for the `quick_match` event, a leader for the 2 s sweep
- `apps/api/.env.example` was committed (9c36e70) with what looked like real credentials (database URL with password, Termii key, Twilio SID, token and number, JWT, salt and internal secrets). The file now holds placeholders, but **the old values are still in git history and must be treated as leaked: rotate every one of them** (and scrub history before any push)

## Messaging follow-ups (deferred from ADR-010)

- Online presence
- Voice notes, photos (storage provider needed)
- Mute / archive, a read-receipt opt-out, an "Add friend" choice when accepting a request
- Push for new messages
- **Redis pub/sub for the realtime hub before running more than one API instance**

## Groups, bots and message actions follow-ups (deferred from ADR-038)

- Group photos: `photo_url` exists but there is no upload service (needs the storage provider); the app shows a cluster of member avatars. A group description and a per-group "who can add people" setting.
- A Space card inside a group thread ("Crazy Cards space, 3 / 4, Take the last seat"; `SpacesService` would post a `game`-like card and update it as seats fill) and group game cards. Today "Start a Space" opens the ordinary Create Space screen and the code is shared by hand. Group Pool needs its own rules (who stakes, who collects).
- Typing per person in a group (the event carries `userId`; the app's tracker is per conversation), "Read by N" for groups (no read receipts at all today), mentions, muting a group (`muted_until` exists, no endpoint).
- Real bots: a practice *game* against a bot (a bot player in the match service), per-bot daily limits, and an LLM behind `botReply` (needs a cost cap, a moderation pass and a prompt-injection review; ADR-038 keeps the schema ready). The quiz has ten questions; the "10 a day" cap in the design is not enforced.
- Forward and "Turn into a challenge" (design: MessageLongPress); reacting with more than five keys; editing a sent message (`edited_at` is used for card updates only).
- Reports: a report from a group still snapshots the whole conversation; trim to the reported message plus context, and show moderators the poll tally.
- Blocking a group member hides their messages from you but you stay in the group together; decide whether leaving should be suggested.
- Realtime for groups sends one `message` event per member from one process (ADR-010's single-instance limit applies; 50 members is the cap). Revisit the hub fan-out with Redis.
- Delete for everyone does not remove the message from a *report snapshot* or from push text already sent (there is no push for messages yet).
- Search: groups are found by name and by their last message on the phone only; there is no server search over group messages.

## Wallet follow-ups (deferred from ADR-012)

- Biometric / device-PIN confirmation before money moves (`expo-local-authentication`; a salted-hash Dyce PIN where none is enrolled)
- Per-day cap (`stranger_scans_per_day`) on resolving codes of non-contacts; today only a per-IP throttle
- Personal "My code" (`/u/<username>`) and paying it; Pool stake UI and disputes
- A scheduled job that expires old requests and updates their chat cards; push for money received / requested

## Profile and Settings follow-ups (deferred from ADR-015)

- Change username: cooldown (design says 30 days) and a reservation of the old name (14 days); rules not in the SPEC yet
- Settings that need their feature (the notification switches are done, ADR-024): who can see me online and Show me in Space (presence, Space search), Pool limits and Free-only (Pools), read receipts switch
- Download my data and Delete account (balance cleared, history anonymised; NDPA 2023); Help and legal screens (needs the legal copy)
- Profile: the city and an invite link in Share (stats, badges, recent games, head-to-head, the Notifications list and its count, and the 75 x level XP curve are done: ADR-024)
- Gate pushed screens (`/settings`, `/profile`) behind sign-in like the tabs are

## Safety follow-ups (deferred from ADR-013)

- Done in ADR-039: the moderation queue and actions (warn, mute, suspend, dismiss), the reporter's outcome notification, the Pool hold, and the spam filter for message requests
- Still open: attach the game moves as evidence on a report from a game, a moderator UI, an appeal path and sanction policy (SPEC is silent), a retention period for signals, sanctions and the audit log, tell the reported person when a mute is lifted

## Platform

- Contact-matching opt-out ("don't let people find me by phone number"): needs a product decision (ADR-008)
- Real Termii/Twilio delivery test; delivery reports
- Done in ADR-040: structured logging with request ids and redaction, Sentry behind a flag, probes, graceful shutdown, images, compose, and the nightly `ledger_check_invariants` job with its audit table and launch-gate script
- **Rotate the credentials committed in `apps/game-server/.env.example` (commit 9c36e70)**: a database URL with a password, a `JWT_SECRET` and an `INTERNAL_SECRET`. The file is clean now, the history is not.
- **Scale beyond one instance (ADR-010, ADR-040):** Redis pub/sub behind `RealtimeHub.publish` and a shared presence set; a shared throttler store; every cron takes an advisory lock before replicas are added (the ledger check already does); a game-server matchmaker. Where one instance tops out: to measure (load test)
- **Push delivery receipts** (the second call, about 15 minutes later) to learn about delivery failures; today only Expo's acceptance is seen
- **Store reviewer account** (an allow-listed number with a fixed code, off by default), needed for App Store and Play review; see the app BACKLOG
- Log retention and a log shipper (needs a platform decision); a `/health/ready` check that fails when the migrations are older than the code (today it only reports the newest applied one)
- A phone-number re-hash migration, so `PHONE_HASH_SALT` can be rotated after a leak without breaking sign-in
- The remaining crons (account erasure, expiry, push) should take an advisory lock like the ledger check before a second API replica is run

## Games platform follow-ups (deferred from ADR-016)

- Pool matches: stakes (`stake_pool`), age gate, mode sheet stake presets and pot, counter-offer (once), 24h no-reply refund, daily limits, payout on finish (`settle_match` already handles the ledger)
- Turn timers and forfeit past the timer (`turn_deadline` is not set yet), "No reply in 24h" invite expiry as a scheduled job (today an invite expires when it is next read)
- Push for "your turn", invites and results; the chat list preview ("Your turn") for a game card
- XP, streaks, badges, the friends leaderboard and the result screen's XP/streak panels; stats on Profile and head-to-head in Chat info
- Games drawer: video thumbnails, search, the category chips beyond what exists, Spaces tiles; the drawer/mode sheet from a group chat
- Spectators (anti-cheat signals are done: ADR-039)
- Reconnect/offline banners and forfeit sheet on the host shell (designs GameOffline, GameForfeit, GameMenu)

## Social layer follow-ups (deferred from ADR-024)

- Push for real: send a test notification through the Expo Push API with a real EAS project id; read delivery **receipts** (a second call ~15 minutes later) to prune tokens; lock-screen actions (Play / Accept / Decline / Later) need categories and background handlers
- Streak saver (24 h to win and restore a lost streak) and "streak at risk" push: need a scheduled job; the badge and level notifications are in-app only
- Opt-out from the global leaderboard and from being found by name; "Near you" and "Playing now" (needs presence); Lagos / Nigeria scoped boards from the design
- Badge detail with progress (e.g. 7 of 10), the Doodle Artist badge (with Doodle Guess), Whot Master counts only finished Whot! games
- A materialized or cached weekly board when the global board gets large (today it aggregates `xp_events` live; `leaderboard_weekly` is unused and could be dropped)
- Push for new chat messages and for "friend joined Dyce"; Redis pub/sub so the `notification` event reaches every API instance
- Search: trigram index for name search among a big friend graph, server-side search of chats and transactions

## Catalogue follow-ups (deferred from ADR-036)

- **Ludo 3-4 players, live (card-room style).** `games.sync` is per slug, so add a second slug (for example `ludo-room`, live, 3-4 players) with a `LIVE_GAMES` `turns` entry (`engine: ludoEngine`, `buildCfg: () => ({ tokens: 4 })`, `autoAction: ludoAutoAction`, `turnMs` about 25 s), its `games` row, and a Spaces table in the app. Async Ludo stays 2 players.
- A per-match option at create (Ayo or Kalah, Darts 501 or Around the clock, Sea Battle salvo, Mini Golf and Word Tiles seat count) instead of one fixed `cfg` per slug.
- Async turn clocks: nothing sets `turn_deadline`, so a timeout does not become the engines' auto action (`fillerAutoAction`, `tanksAutoAction`, `miniGolfAutoAction`, a Word Tiles pass, a harmless 8 Ball or Darts shot) and a no-show never forfeits.
- Spaces' seat fee should respect `games.pool_min_stake_kobo` too (only async matches check it today).
- A bigger Word Tiles dictionary (public-domain ENABLE, licence permitting) loaded through `WORD_TILES_WORDLIST_FILE` before Pool is switched on for it; keep the old id registered while its matches are live.

## Edge flows follow-ups (deferred from ADR-037)

- **Money rule for an upheld dispute** (needs a human): `reverse_txn` of the settle transaction fails when the winner has spent the pot. Decide between a capped correction with a recorded shortfall, an `adjust` from `system_adjust`, or limiting disputes to while the winner still holds the pot. Until then `resolve_dispute(..., 'reversed', ...)` needs a reversal an admin has posted by hand.
- A payout hold exists now (ADR-039) but only *before* settlement. A dispute opened after the pot was paid still cannot freeze it (the money rule above is still open); a dispute on a match that an anti-cheat signal flagged but did not hold could point the moderator at its signals (they are in `moderation_signal_queue` by match id).
- Done: a moderation tool on top of `moderation_dispute_queue` (ADR-039, JSON API and CLI, no UI by design for v1). Still open: a push or notification when a dispute is decided (`_notify` kind `dispute_resolved`, and the app's Notifications list mapping).
- Account deletion: hide the profile during the 30 day grace period; decide whether messages a deleted person sent should stay with the recipients (NDPA erasure, legal review); push the cancelled-match change to the other player's card (it catches up when read); delete also the person's uploaded media once chats carry photos; a "deletion cancelled, welcome back" signal in the sign-in response.
- Streak saver (SPEC section 9: 24 hours to win one game after losing a streak). Not buildable on the current data: the award trigger (0018) resets a broken streak to 1 and `streaks.saver_expires_at` is never written. A rule that fits: a `BEFORE UPDATE` snapshot of `streaks.current` and `last_win_date` on the finishing match, and an `AFTER` step that, for a **Free** win on the Lagos day after the missed day (`last_win_date + 2`), sets `current = snapshot + 1`; plus `GET /me/streak` (`current`, `best`, `lost: { length, restoreUntil } | null`) for the StreakLost screen.
- Per-game record for the game detail sheet ("19 W · 11 L", biggest pot, friends who play) and badge progress and rarity (`N / M`, "12% of players"): needs aggregate endpoints.
- Public spaces (`visibility: 'public'`) with "Open now" and search by name for strangers; a seat-opened waitlist ("Notify me if a seat opens").
- Conversation mute (`conversation_members.muted_until` exists, no endpoint) for the game menu's mute row.

## Integrity follow-ups (deferred from ADR-039)

- **The app does not send the device headers yet.** `x-dyce-device` (a random install id kept in secure storage), `x-dyce-platform` and, once the store integration exists, `x-dyce-attestation`. Until it does, the shared-device signal and the attestation check have nothing to read and only IP sharing works. The app also has to call `POST /integrity/challenge` first for the nonce.
- **Play Integrity and App Attest** (human-gated): the verification code in `StoreAttestationVerifier`, the Play Console / Google Cloud and Apple developer setup, the app's native modules, then `integrity_required = true`. Until then production runs `INTEGRITY_DRIVER=store` with `integrity_required = false`.
- **Tune the signals with real data**: every weight and limit in ADR-039 is a first guess. Plan: ship with `integrity_hold_threshold` at 90 for the first weeks, read the flagged queue, lower it. Measure false holds (released) against caught ones.
- Judge Free matches too (XP and leaderboard farming), and score friend requests and game invites with the same spam filter (today only message requests and first messages are scored).
- A hold only exists before settlement. Anything that should reach back to a paid pot needs the ADR-037 money decision first.
- Moderator ergonomics: a UI, alerts when a hold is close to lapsing (today: `lapses_at` in the hold queue and a log line when a hold lapses), assignment between moderators, saved replies.
- Per-instance rate-limit counters (ARCHITECTURE: needs Redis with more than one API instance); the per-address limit still applies to anonymous routes.
