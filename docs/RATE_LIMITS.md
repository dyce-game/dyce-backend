# Rate limits

Reviewed for Phase 5 (ADR-039). Two layers: **HTTP throttles** (per route, in the controllers, in-process) and **rules in the service or database** (per person per day, config-driven, survive restarts and several API instances). A throttle is a safety net against floods; the limits that matter to the product are the second kind.

## How HTTP throttles count

- Global ceiling: **120 requests a minute** per tracker, on every route (`ThrottlerModule` in `app.module.ts`). A route's `@Throttle` replaces it for that route.
- The tracker is the **signed-in account** when the request carries a valid access token, otherwise the **client address** (`UserThrottlerGuard`, `throttleTracker`). Carrier-grade NAT puts many Nigerian phones behind one IP, so counting every route per address would lock neighbours out together. A token that does not verify counts as an anonymous request from its address, so a forged token can never spend someone else's allowance.
- Behind a load balancer set `TRUST_PROXY_HOPS` so the address is the client's, not the balancer's.
- The store is in memory: a second API instance has its own counters (limits are per instance until a Redis store is added, as for the realtime hub).
- A refused request is `429 { code: 'rate_limited' }`; a refusal from a service rule carries its own code and `Retry-After`.

## HTTP throttles, per minute unless stated

| Area | Route | Limit | Why |
| --- | --- | --- | --- |
| Auth | `POST /auth/otp/request`, `/auth/otp/verify` | 10 per address | SMS cost and guessing; per-phone rules below are the real control |
| Auth | `POST /auth/email/otp/request`, `/me/email/request` | 5 per address | email cost and mail bombing; the per-address rules below are the real control (ADR-044) |
| Auth | `POST /auth/email/otp/verify`, `/me/email/verify`, `/me/phone/request`, `/me/phone/verify` | 10 per address | guessing |
| Auth | `POST /auth/refresh` | 30 per address | token stuffing |
| Money | `POST /wallet/send` | 30 | |
| Money | `POST /wallet/requests` | 30 | |
| Money | `GET /wallet/requests/:code` | 40 | scanning strangers' codes; the per-day cap below is the real control |
| Money | `POST /wallet/requests/:code/pay` | 30 | |
| Chat | `POST /conversations/direct` | 60 | |
| Chat | `POST /conversations/:id/messages` | 60 | |
| Chat | reactions, votes | 120 | cheap and idempotent |
| Chat | delete a message | 60 | |
| Chat | create a group | 10 | plus 10 a day below |
| Chat | polls, rename, leave | 20 | |
| Chat | add / remove / promote members | 30 | |
| Chat | start a bot chat | 30 | |
| Requests | `POST /friends/requests` | 30 | plus the daily cap below |
| Requests | `GET /users/by-username/:username` | 30 | |
| Requests | `POST /contacts/match` | 30 | |
| Matches | `POST /matches` (send a game) | 30 | |
| Matches | `POST /matches/:id/accept` | 30 | new in ADR-039: it takes a stake |
| Matches | `POST /matches/:id/counter` | 20 | new in ADR-039 |
| Matches | `POST /matches/:id/moves` | 120 | |
| Matches | `POST /matches/:id/resign` | 20 | |
| Matches | `POST /matches/:id/dispute` | 10 | plus 5 a day below |
| Spaces | create / join | 20 | |
| Spaces | lookup by code | 30 | code guessing |
| Spaces | `POST /spaces/:id/connect` | 30 | |
| Quick match | join | 20 | plus 30 an hour below |
| Quick match | accept | 30 | |
| Safety | `POST /blocks` | 30 | |
| Safety | `POST /reports` | 10 | plus 20 a day below |
| Discovery | `GET /search/people` | 40 | plus a daily cap below |
| Discovery | profiles, leaderboards | 60 | |
| Invites | send | 20 | plus daily caps below |
| Invites | claim | 20 | |
| Invites | link preview, guest game | 30 to 60 | public, per address |
| Device check | `POST /integrity/challenge` | 20 | new in ADR-039 |
| Moderation | every `/admin/moderation` route | 60 | new in ADR-039 |
| Moderation | `POST /admin/moderation/holds/:id/resolve` | 20 | it moves money |
| Account | `POST /me/delete` | 5 an hour | |
| Account | `GET /me/export` | 3 an hour | |
| Push | register / remove a token | 20 | |

## Rules in services and the database (per person, `app_config`)

| What | Limit | Where it is enforced |
| --- | --- | --- |
| OTP codes per phone | 30 s between, 3 in 10 min, 10 a day, 5 wrong tries per code | `AuthService` |
| OTP codes per email address | the same limits as the phone, counted per address hash | `AuthService` (ADR-044) |
| New people you message (strangers) | 20 a Lagos day (`stranger_requests_per_day`) | `MessagesService` |
| Messages before they answer | 3 (`request_messages_before_accept`), deleted ones included | `MessagesService` |
| Friend requests | 50 a day (`friend_requests_per_day`) | `FriendsService` |
| Contact lookups | 10,000 a day (`contact_lookups_per_day`) | `ContactsService` |
| People searches | 600 a day (`people_searches_per_day`) | `SearchService` |
| Groups created | 10 a day (`groups_created_per_day`) | `GroupsService` |
| Reports filed | 20 a day (`reports_per_day`) | `SafetyService` |
| Disputes opened | 5 a day (`disputes_per_day`) | `DisputesService` |
| Open game invites in one chat | 5 (`open_match_invites_per_chat`) | `MatchesService` |
| **Money sent** | ₦50,000 a send, ₦200,000 a day (`send_limit_kobo`, `send_daily_limit_kobo`) | SQL `transfer` |
| **Open money requests** | 10 (`max_open_requests`) | SQL `create_payment_request` |
| **Money requests made** | **30 a Lagos day** (`money_requests_per_day`) | `WalletService` (new: the config key existed since migration 0006 and nothing read it) |
| **Strangers' codes opened** | **20 different codes a Lagos day** (`stranger_scans_per_day`); a friend's or contact's code and one already opened do not count; paying a code counts too | `WalletService`, table `stranger_scans` (new, same story) |
| Pool stakes | ₦100 to ₦20,000 a game, 20 games and ₦100,000 a day (`pool_*`), 18+, not frozen | SQL `stake_pool` |
| Quick match searches | 30 an hour (`quick_match_per_hour`); three skipped or missed matches in 10 minutes means a wait | `QuickMatchService` |
| Spaces open at once | `spaces_open_per_user` | `SpacesService` |
| SMS invites | 50 a day, 3 per number a day, one text per number at a time | `InvitesService` |
| Daily top-up | once per Lagos day, only under ₦10,000 | SQL `claim_daily_topup` |
| Realtime sockets | 5 per person, 4 KB frames, typing 20 per 10 s | `RealtimeServer` |

## Limits that react to behaviour (not counts)

- **Request spam filter** (ADR-039): a new account, mass sending, repeated declines or reports put a stranger's request in the recipient's filtered bucket (`spam_*` config).
- **Pool payout hold** (ADR-039): a Pool match whose signals add up to 70 waits for a moderator before it pays (`integrity_*` config).
- **Mute and suspension** (ADR-039): a moderator can stop a person messaging, sending friend requests and making money requests (mute) or signing in and entering Pool (suspension).

## Review, 2026-11-23

Checked every controller and every service rule against SPEC §13 and WALLET_AND_QR. Found and fixed: two limits promised in the docs and in `app_config` but never enforced (**money requests a day**, **strangers' codes a day**), the missing throttles on **accepting and countering a Pool match**, and the **per-address counting** that would have throttled whole mobile networks together. Not changed, on purpose: the numbers in the table above (nothing here has real traffic behind it; revisit after the first beta weeks), and the in-memory counter store (needs Redis with more than one API instance, see ARCHITECTURE).
