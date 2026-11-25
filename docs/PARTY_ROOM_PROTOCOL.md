# Live rooms: the protocol (Crazy Cards, Imposter, Werewolf, Charades, Doodle Guess)

For the people building the party-game screens. Decisions and reasons are in ADR-025 (and ADR-022, ADR-023); this file is what goes over the wire. Whot! and Crazy Cards are turn rooms, the other four are party rooms; everything below applies to both unless it says otherwise. Types are in `packages/shared/src/schemas/spaces.ts` (`LiveState`, `LiveError`, `LiveChat`, `LiveClientMessage`) and `packages/games/src` (engine actions, `CanvasMessage`).

## 1. Getting to a table

1. **HTTP, signed in** (the lobby is unchanged from ADR-022): `POST /spaces` (`gameSlug`, `maxSeats`, `mode`, `seatFeeKobo`, `payoutScheme`, `visibility`, `startRule`, **`options`**), `POST /spaces/join { code }`, `POST /spaces/:id/start`. `SpaceView` now also carries `options` and `quickMatch`.
2. `POST /spaces/:id/connect` → `{ url, roomId, matchId }`. It makes sure the room exists (it may have been lost in a game-server restart); call it on every (re)connect.
3. **Colyseus:** `new Client(url).joinById(roomId, { token })` with a fresh access token. The room id is the match id. Refusals: 4401 bad token, 4403 not seated, 4404 match not running (over, or never started: stop retrying). Close code **4010** means the same account joined from another device: do not reconnect by yourself.
4. Reconnect any time the socket drops (backoff). A seat stays for **60 s** offline (`RECONNECT_SECONDS`); after that it forfeits. Everything needed is in the first `state` (and `canvas`, `chat_history`) a join gets, so a reconnect needs no other call. The app's `LiveConnection` already does all of this.

| game | slug | seats in a Space | room | Pool schemes |
| --- | --- | --- | --- | --- |
| Whot! | `whot` | 2 to 4 | turns | any |
| Crazy Cards | `crazy-cards` | 2 to 4 | turns | any |
| Imposter | `imposter` | 4 to 10 | party | winner takes all (the winning side shares) |
| Werewolf | `werewolf` | 5 to 12 | party | winner takes all (the winning side shares) |
| Charades | `charades` | 3 to 10 | party | any (placements by team score) |
| Doodle Guess | `doodle-guess` | 3 to 8 | party | any (placements by points) |

`options` at `POST /spaces` (all optional; anything else is `invalid_options`): Imposter `clueRounds` 1 to 3 and `imposters` 1 or 2 (dropped if it would be half the table); Charades `mode` `act` | `headsup` and `rounds` 1 to 5; Doodle Guess `rounds` 1 to 5. Werewolf, Whot and Crazy Cards have none.

## 2. Messages

**Client → room** (Colyseus message names):

| message | body | notes |
| --- | --- | --- |
| `move` | `{ expectedVersion?, action }` | `action` is the engine action (section 4). **Turn rooms require `expectedVersion`** (the `version` of the state you were looking at; a stale one is refused). **Party rooms ignore it**: many seats act at once. A `tick` action is always refused. |
| `chat` | `{ text }` | Party rooms only, up to 200 characters, profanity refused. Who hears it depends on the game and the phase (section 5). |
| `sync` | none | Asks for the current `state` (and `canvas`) again. |
| `leave` | none | Forfeits the seat (the app confirms first). |

**Room → client:**

| message | body | when |
| --- | --- | --- |
| `state` | `LiveState` | On join, on `sync`, and whenever something **this seat can see** changes. A ticking countdown is not a change: count down from `turnDeadlineAt` yourself. |
| `error` | `{ code, expectedVersion? }` | A refused `move`/`chat`. Followed by a fresh `state`, except for `rate_limited`. |
| `chat` | `LiveChat { id, userId, text, at }` | One line of table talk this seat is allowed to hear. |
| `chat_history` | `LiveChat[]` | On every join: the recent lines this seat was allowed to hear (merge by `id`). |
| `canvas` | `CanvasMessage` | Doodle Guess only (section 4.5). |

**`LiveState`** (per seat, from `engine.view(state, you)`):

```
matchId, spaceId, gameSlug, mode,
version        bumps with every accepted action and every tick that changed something
status         'live' | 'finished'
view           the engine's own view for YOU (section 4); never the raw state
seats[]        { userId, seat, connected, forfeited }
roomKind       'turns' | 'party'
canAct         you may act right now (your turn / the engine is waiting for something from you)
waiting        party rooms: clocks are stopped until every seat has connected (see below)
turnUserId     turn rooms: whose clock runs. ALWAYS null in party rooms (it would give roles away)
turnDeadlineAt turn rooms: when the room plays for the player on turn. Party rooms: when the current phase ends
serverNow      the server clock when this was sent. Use serverNow and turnDeadlineAt together, never the device clock
results        set once finished and paid: [{ userId, placement, result, payoutKobo }]
```

**Waiting.** A party room starts its clocks when every seat has connected once. Until then `waiting` is true, `turnDeadlineAt` null and nobody can act. A seat that never shows up forfeits after 90 s (`JOIN_GRACE_SECONDS`) and the game starts without it. The same applies when a room is rebuilt after a game-server restart: seats must come back first.

**Refusal codes** (`error.code`, sometimes `code:reason` with the engine's reason): `invalid_action`, `not_your_turn` (you cannot act now), `illegal_move:<engine code>`, `stale_version` (turn rooms), `rate_limited`, `waiting`, `chat_closed`, `forfeited`, `not_running`, `not_seated`, `server_error`. A bot or a fast finger that answers an old state gets `not_your_turn` or `illegal_move:wrong_phase`: harmless, ignore it.

**Limits.** A seat may send 30 actions in a burst and earns 15 more per second (`rate_limited` past that); one chat line per 600 ms. A drawing reaches the other seats at most about every 150 ms; see 4.5.

## 3. Time

The engines read no clock. The room sends them `tick` (as the room, never a seat) every second with the real time that passed, and a phase ends when its timer reaches zero (a missing vote becomes an abstention, a silent speaker gets an empty clue, a drawer who did not choose gets the first word). The app only draws the countdown: `secondsLeft = ceil((turnDeadlineAt - (serverNow + (now - receivedAt))) / 1000)`.

When the clock is only waiting for seats that have **forfeited** (a drawer who left, the last unvoted players), the room runs it forward in quarter-second steps instead of making the table wait. A seat that is merely offline is waited for, up to its 60 s.

## 4. The games

All actions are `{ kind: ... }` and are validated by zod and the engine; an illegal one is an `error`, never a crash. `by` is always you.

### 4.1 Crazy Cards (turn room)

`view`: `players, current, turn, dir, hand (yours), counts{userId:n}, deckCount, pileCount, top, color, drawn (only for the player on turn), winner, endReason ('out'|'blocked'|null), last (event for animation), hands?/points? (only when over)`. Actions: `{kind:'play', card:{color,value}, color?, call?}` (a Wild needs `color`; **`call: true` is required on the play that leaves one card**, otherwise the player draws 2), `{kind:'draw'}`, `{kind:'pass'}` (after a draw that found a playable card). 25 s turn clock; the room plays for a seat that times out or left (`crazyCardsAutoAction`). Helpers `crazyCanPlay`, `crazyCardsLegalActions` (server only: it reads hands) are in `@dyce/games`.

### 4.2 Imposter (party room)

Phases `reveal → clue → vote → guess → over`. Timers (defaults): reveal 10 s, clue 20 s per speaker, vote 45 s, guess 20 s.
`view`: `players, phase, timeLeftMs, imposterCount, packLabel, role ('crew'|'imposter'|null), word (crew only, everyone at the end), partners (imposters see each other), imposters (end only), order, speaker, round, clueRounds, clues[{round,by,text|null}], ready[], voted[], myVote, votes?/tally?/accused (from the guess phase), guessed[], guesses? (end), winner ('crew'|'imposters'|null), seq`.
Actions: `{kind:'ready'}` (reveal), `{kind:'clue', text}` (your turn only, 1 to 3 words), `{kind:'vote', targets:[userId...]}` (exactly `imposterCount` other players), `{kind:'guess', text}` (an imposter, if all imposters were caught).
Chat: only during `vote` and after the game. Placements: winning side first, other side second.

### 4.3 Werewolf (party room)

Phases `night → day → vote → night ...` until `over`. Timers: night 30 s, day 60 s, vote 30 s; a night ends as soon as every living role has acted.
`view`: `players, phase, night, timeLeftMs, alive[], dead[], composition{werewolf,seer,doctor,villager}, role (yours), revealed{userId:role} (the dead), roles? (only the dead and at the end), wolves? (wolves only), wolfTargets? (living wolves only), inspecting?/seerLog? (seer), protecting? (doctor), acted (your own night action done), ready[], voted[], myVote, log[], winner ('villagers'|'werewolves'|'draw'|null), seq`.
Actions: `{kind:'kill'|'inspect'|'protect', target}` (night, by role), `{kind:'ready'}` (day: end the discussion early), `{kind:'vote', target: userId|null}` (null abstains). `canAct` at night is true only for the roles that still owe an action: that is *your own* ability, never anyone else's.
Chat: at night only the living wolves (the dead listen); by day the living talk to everyone; the dead talk only to the dead and hear everybody; at the end everyone. The dead spectate: their `view` shows every role. Ten nights without a winner is a draw (every stake refunded).

### 4.4 Charades (party room)

Phases `ready → acting → ready ... → over`. Teams of 2 (4+ players; `teams` up to 4) or everyone for themselves (3 players). `ready` 20 s, `acting` 60 s, up to 8 cards, 3 skips.
`view`: `players, teams, solo, mode, phase, timeLeftMs, turn, turns, actor, actorTeam, scores[] (per team), category, word (see below), cardNo, cardsPerTurn, skipsLeft, last{seq,kind,by,guesser,text}`. **`word`**: in `act` mode only the actor sees the card; in `headsup` everyone except the actor does. Spectators never.
Actions (actor only): `{kind:'start'}`, `{kind:'got_it', guesser?}` (name who guessed it; required when everyone plays alone), `{kind:'skip'}`.
Chat: everyone but the actor while they act. Placements: by team score, each member takes their team's place; level scores are a draw.

### 4.5 Doodle Guess (party room)

Phases `choose → draw → choose ... → over`. `choose` 10 s, `draw` 80 s, 3 rounds by default.
`view` (**without the drawing**): `players, phase, timeLeftMs, turn, turns, round, rounds, drawer, packLabel, choices[] (drawer, choose phase), word (drawer and those who solved), mask[] (letters you may see, null for hidden ones), strokeCount, solvers[], scores{}, feed[] (guesses, 'close', 'correct'), history[], seq`.
Actions: `{kind:'choose', index 0..2}`, `{kind:'stroke', points:[[x,y]...≤64], color 0..15, width 1..8, cont?}` (`cont: true` extends the previous stroke so a long line can be streamed in pieces; coordinates are integers 0 to 1000), `{kind:'undo'}`, `{kind:'clear'}`, `{kind:'guess', text}`. The canvas is capped at 300 strokes and 4,000 points a turn (`canvas_full`).
**The drawing is its own message.** `canvas` = `{ turn, reset, strokes[], extend[] }`; apply every one in order with `applyCanvas(strokes, msg)` from `@dyce/games`: `reset: true` replaces everything (join, `sync`, a new turn, undo, clear), otherwise `extend` adds points to strokes you hold (`{id, pts}`) and then `strokes` are appended. A guesser sees the drawing while the room batches: strokes reach other seats at most every ~150 ms and the database every ~1.5 s. Draw locally at once and let the room's messages confirm.
Guess scoring: `50 + floor(150 * timeLeft / drawMs)`, the drawer earns half of each. A guess one edit away from the word is shown as 'close' (the text is not).

## 5. Money, results and leaving

- **Pool** seat fees are escrowed when a person sits down and paid by `settle_match` in the transaction that finishes the match: the room never moves money. `results[i].payoutKobo` is what each seat got. A draw refunds every stake.
- A seat that **leaves** (the `leave` message, or gone 60 s) forfeits: last place, `result: 'forfeit'`, no money, and the game goes on without it (the timers fill in for it). If one player is left they win at once. Everyone gone: the stakes go back.
- When `status` becomes `finished` the room stays open about 45 s, then closes the socket (the app treats that as the end, not a drop) and the Space becomes `ended`. The result screen reads `SpaceView.members[].placement/result/payoutKobo`.
- Leaving a game before it starts is `POST /spaces/:id/leave` (the seat fee is returned).

## 6. Quick match (HTTP + one realtime event)

For strangers, 1 v 1, in the games with `quickMatch` (today Whot! and Crazy Cards). Strangers get **no chat**: nothing here creates a conversation or a friendship; anything either writes later goes to Requests.

| call | what |
| --- | --- |
| `GET /quick-match` | `{ ticket: QuickMatchTicket \| null, games[] }`: your open search, or the one that ended in the last 2 minutes. |
| `POST /quick-match { gameSlug, mode, stakeKobo? }` | Joins the queue. Repeating the same search returns the same ticket; a different one while searching is `quick_match_active`. Pool needs 18+, enough cash and a stake inside the limits (`invalid_stake`, `adult_required`, `insufficient_funds`). |
| `POST /quick-match/:id/cancel` | Leaves the queue (or turns a found match down). |
| `POST /quick-match/:id/accept` / `decline` | Answer a found match. |

`QuickMatchTicket.status`: `searching` → `found` (a stranger is paired, **Pool stakes are locked now**; `acceptBy` and `opponent` {username, avatar, level, winRatePct, games} are set) → `playing` (both accepted; `spaceId` is the live space: open it like any space, with `POST /spaces/:id/connect`). End states: `cancelled`, `expired` (nobody found in 60 s), `declined`, `missed` (the 10 s window ran out; stakes refunded), `failed` (`errorCode`: a stake was refused). If the other person declines or misses, you go back to `searching` with your place kept.
Realtime: `{ type: 'quick_match', ticket }` on `/realtime` for every change; while searching the app also polls `GET /quick-match` every 1.5 s. Rules: similar level first (gap 3), anyone after 15 s; never a blocked pair; never the same two people within 10 minutes; at most 30 searches an hour; three skipped or missed matches in 10 minutes means a short wait (`quick_match_cooldown`).

## 7. What the party screens need that is not here yet

- **Real art and scenes** (round table, campfire, the Skia canvas): everything above is data only.
- A **spectator** is only a dead Werewolf player. Watching a game you are not in is not offered (nothing in the designs asks for it).
- **Bots** to replace a forfeited seat in Free: not built (the timers fill in).
- Doodle: the canvas is the only streamed part today. If another game needs one, add a `stream` to its entry in `packages/games/src/live.ts` (`split` and `diff`) and the room sends `canvas`-style deltas for it.
- Lobby chat before the game and "Play again with the same seats" are not built (BACKLOG).
