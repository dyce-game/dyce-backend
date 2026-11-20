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

- Public Spaces ("Open now" list, `visibility = 'public'`), quick match with the 10 s accept, "People" (Playing now / Near you / Top this week) on the Spaces tab
- Lobby chat, invite friends from the lobby (today: the code and a share link), a ready toggle, lock seats, host-passes-on notification, spectators
- Free spaces pay no XP yet (60 / 30 / 15 in the design); Spaces count toward streaks and badges when the progression work lands
- Replace a forfeited Free seat with a bot instead of auto-playing it (ARCHITECTURE option), Whot for 5 to 6 seats, rematch with the same seats ("Play again")
- Scale-out: Colyseus Redis presence and driver, sticky routing, a Redis bus for the `space` event; publish `space` events from the game server when a game ends so lobbies refresh without a refetch
- Push: "space starting" for seats who are not in the app (they get 90 s to show up before the seat forfeits)
- Disputes and collusion signals for Space pots (same people trading pots)

## Messaging follow-ups (deferred from ADR-010)

- Groups (create, members, admins, polls), Bots, online presence
- Replies, reactions, delete for me / for everyone, voice notes, photos (storage provider needed)
- Mute / archive, a read-receipt opt-out, an "Add friend" choice when accepting a request
- Push for new messages
- **Redis pub/sub for the realtime hub before running more than one API instance**

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

- A moderation queue and the actions on a report (warn, mute, suspend), outcome notifications to the reporter
- Hold and refund a Pool stake when cheating is reported; attach game moves as evidence once matches exist
- Spam filtering of requests (new accounts, mass sending, reported users)

## Platform

- Contact-matching opt-out ("don't let people find me by phone number"): needs a product decision (ADR-008)
- Real Termii/Twilio delivery test; delivery reports
- Structured logging and Sentry; a nightly job for `ledger_check_invariants`

## Games platform follow-ups (deferred from ADR-016)

- Pool matches: stakes (`stake_pool`), age gate, mode sheet stake presets and pot, counter-offer (once), 24h no-reply refund, daily limits, payout on finish (`settle_match` already handles the ledger)
- Turn timers and forfeit past the timer (`turn_deadline` is not set yet), "No reply in 24h" invite expiry as a scheduled job (today an invite expires when it is next read)
- Push for "your turn", invites and results; the chat list preview ("Your turn") for a game card
- XP, streaks, badges, the friends leaderboard and the result screen's XP/streak panels; stats on Profile and head-to-head in Chat info
- Games drawer: video thumbnails, search, the category chips beyond what exists, Spaces tiles; the drawer/mode sheet from a group chat
- Dispute and anti-cheat signals on matches; spectators
- Reconnect/offline banners and forfeit sheet on the host shell (designs GameOffline, GameForfeit, GameMenu)

## Social layer follow-ups (deferred from ADR-024)

- Push for real: send a test notification through the Expo Push API with a real EAS project id; read delivery **receipts** (a second call ~15 minutes later) to prune tokens; lock-screen actions (Play / Accept / Decline / Later) need categories and background handlers
- Streak saver (24 h to win and restore a lost streak) and "streak at risk" push: need a scheduled job; the badge and level notifications are in-app only
- Opt-out from the global leaderboard and from being found by name; "Near you" and "Playing now" (needs presence); Lagos / Nigeria scoped boards from the design
- Badge detail with progress (e.g. 7 of 10), the Doodle Artist badge (with Doodle Guess), Whot Master counts only finished Whot! games
- A materialized or cached weekly board when the global board gets large (today it aggregates `xp_events` live; `leaderboard_weekly` is unused and could be dropped)
- Push for new chat messages and for "friend joined Dyce"; Redis pub/sub so the `notification` event reaches every API instance
- Search: trigram index for name search among a big friend graph, server-side search of chats and transactions
