export * from './contract.ts';
export * from './rng.ts';
export * from './hash.ts';
export * from './_example/engine.ts';
export * from './whot/engine.ts';
export * from './wordhunt/engine.ts';
export { WORD_HUNT_WORDS, WORD_HUNT_DICT_ID } from './wordhunt/words.ts';
export * from './cuppong/engine.ts';
export {
  simulateThrow as simulateCupPongThrow,
  launchSpeed as cupPongLaunchSpeed,
  AIM_MAX as CUP_PONG_AIM_MAX,
  POWER_MAX as CUP_PONG_POWER_MAX,
  type CupPos as CupPongCup,
  type ThrowInput as CupPongInput,
  type ThrowOutcome as CupPongOutcome,
  type ThrowSim as CupPongSim,
} from './cuppong/physics.ts';
export * from './crazycards/engine.ts';
export * from './doodleguess/engine.ts';
export * from './imposter/engine.ts';
export * from './werewolf/engine.ts';
export * from './charades/engine.ts';
export {
  ROOM_ACTOR,
  MAX_TICK_MS,
  isRoomOnlyAction,
  isCleanText,
  type TickAction,
} from './party/common.ts';
export {
  WORD_PACKS,
  WORD_PACKS_VERSION,
  CHARADES_PACKS,
  type WordPack,
  type CharadesPack,
  type CharadesPrompt,
} from './party/words.ts';
export * from './darts/engine.ts';
export * from './archery/engine.ts';
export {
  flyArrow as flyArcheryArrow,
  arrowSpeed as archeryArrowSpeed,
  DISTANCE as ARCHERY_DISTANCE,
  AIM_MAX as ARCHERY_AIM_MAX,
  DRAW_MAX as ARCHERY_DRAW_MAX,
  type ArrowInput as ArcheryInput,
  type ArrowFlight as ArcheryFlight,
} from './archery/physics.ts';
export * from './basketball/engine.ts';
export {
  simulateShot as simulateBasketballShot,
  launchSpeed as basketballLaunchSpeed,
  RACKS as BASKETBALL_RACKS,
  AIM_MAX as BASKETBALL_AIM_MAX,
  POWER_MAX as BASKETBALL_POWER_MAX,
  type ShotInput as BasketballInput,
  type ShotOutcome as BasketballOutcome,
  type ShotSim as BasketballSim,
} from './basketball/physics.ts';
export * from './eightball/engine.ts';
export {
  simulateShot as simulateEightBallShot,
  cueSpeed as eightBallCueSpeed,
  POCKETS as EIGHT_BALL_POCKETS,
  TABLE_L as EIGHT_BALL_TABLE_L,
  TABLE_W as EIGHT_BALL_TABLE_W,
  BALL_R as EIGHT_BALL_BALL_R,
  DMM as EIGHT_BALL_DMM,
  POWER_MAX as EIGHT_BALL_POWER_MAX,
  ANGLE_MAX as EIGHT_BALL_ANGLE_MAX,
  SPIN_MAX as EIGHT_BALL_SPIN_MAX,
  type TableBall as EightBallTableBall,
  type ShotInput as EightBallInput,
  type ShotOutcome as EightBallOutcome,
  type ShotSim as EightBallSim,
  type PocketEvent as EightBallPocketEvent,
} from './eightball/physics.ts';
export { sinCosCenti, wrapCenti, FULL_TURN_CENTI } from './physics/angles.ts';
export * from './determinism/scenario.ts';
export * from './live.ts';
export {
  CHAT_MAX_CHARS,
  cleanChatText,
  chatAudienceFor,
  applyCanvas,
  diffCanvas,
  splitDoodleView,
  type CanvasCursor,
  type CanvasMessage,
  type CanvasStroke,
} from './party/live-adapters.ts';

// Phase 4 word and arcade engines (ADR-029 to ADR-033).
export * from './anagrams/engine.ts';
export { canSpell as anagramsCanSpell } from './anagrams/engine.ts';
export * from './filler/engine.ts';
export {
  createWordTilesEngine,
  wordTilesEngine,
  wordTilesWordSet,
  wordTilesActionSchema,
  wordTilesAnalysePlay,
  wordTilesPlays,
  wordTilesPremium,
  makeWordSet as makeWordTilesWordSet,
  rackHolds as wordTilesRackHolds,
  tilesNeeded as wordTilesTilesNeeded,
  BOARD_SIZE as WORD_TILES_BOARD_SIZE,
  CENTER as WORD_TILES_CENTER,
  RACK_SIZE as WORD_TILES_RACK_SIZE,
  BINGO_BONUS as WORD_TILES_BINGO_BONUS,
  WORD_TILES_LETTER_VALUES,
  WORD_TILES_DISTRIBUTION,
  WORD_TILES_PREMIUMS,
  type WordSet as WordTilesWordSet,
  type Premium as WordTilesPremium,
  type PlayAnalysis as WordTilesPlayAnalysis,
  type WordTilesAction,
  type WordTilesCfg,
  type WordTilesMove,
  type WordTilesPlay,
  type WordTilesState,
  type WordTilesTile,
} from './wordtiles/engine.ts';
export { WORD_TILES_WORDS, WORD_TILES_DICT_ID } from './wordtiles/words.ts';
export * from './minigolf/engine.ts';
export {
  MINI_GOLF_COURSE,
  miniGolfHole,
  FIELD_W as MINI_GOLF_FIELD_W,
  FIELD_H as MINI_GOLF_FIELD_H,
  HOLES as MINI_GOLF_HOLES,
  MAX_STROKES as MINI_GOLF_MAX_STROKES,
  type HoleDef as MiniGolfHole,
  type Rect as MiniGolfRect,
  type Circle as MiniGolfCircle,
} from './minigolf/course.ts';
export {
  simulatePutt as simulateMiniGolfPutt,
  puttSpeed as miniGolfPuttSpeed,
  BALL_R as MINI_GOLF_BALL_R,
  CUP_R as MINI_GOLF_CUP_R,
  AIM_MAX as MINI_GOLF_AIM_MAX,
  POWER_MAX as MINI_GOLF_POWER_MAX,
  type PuttInput as MiniGolfInput,
  type PuttOutcome as MiniGolfOutcome,
  type PuttSim as MiniGolfSim,
} from './minigolf/physics.ts';
export * from './tanks/engine.ts';
export {
  simulateShot as simulateTanksShot,
  carve as tanksCarve,
  groundAt as tanksGroundAt,
  tankCentre as tanksTankCentre,
  WEAPONS as TANKS_WEAPONS,
  WORLD_W as TANKS_WORLD_W,
  WORLD_H as TANKS_WORLD_H,
  COLS as TANKS_COLS_COUNT,
  COL_W as TANKS_COL_W,
  TANK_RADIUS,
  TANK_HP,
  POWER_MAX as TANKS_POWER_MAX,
  ANGLE_MAX as TANKS_ANGLE_MAX,
  type Impact as TanksImpact,
  type ImpactKind as TanksImpactKind,
  type ShotSim as TanksShotSim,
  type Weapon as TanksWeapon,
  type WeaponSpec as TanksWeaponSpec,
} from './tanks/physics.ts';
export * from './chess/engine.ts';
export * from './checkers/engine.ts';
export * from './ayo/engine.ts';
export * from './dotsandboxes/engine.ts';
export * from './ludo/engine.ts';
export * from './seabattle/engine.ts';
