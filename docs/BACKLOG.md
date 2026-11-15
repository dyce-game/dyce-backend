# Backlog (backend)

Product-level deferrals (tournaments, voice/video in Spaces, real-money anything, ...) are in `../Dyce/docs/BACKLOG.md`.

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
- Settings that need their feature: notification switches (push), who can see me online and Show me in Space (presence, Space search), Pool limits and Free-only (Pools), read receipts switch
- Download my data and Delete account (balance cleared, history anonymised; NDPA 2023); Help and legal screens (needs the legal copy)
- Profile: real stats (games, win rate, Pool net, best pot), earned badges and the "See all" badges screen, Recent games, head-to-head, the city, a Notifications list and its badge count, an invite link in Share, and confirming the XP curve (75 x level per level, assumed from the design)
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
