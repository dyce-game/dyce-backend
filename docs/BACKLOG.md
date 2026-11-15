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

## Platform
- Block and report endpoints, spam filtering of requests, moderation queue
- Contact-matching opt-out ("don't let people find me by phone number"): needs a product decision (ADR-008)
- Real Termii/Twilio delivery test; delivery reports
- Structured logging and Sentry; a nightly job for `ledger_check_invariants`
