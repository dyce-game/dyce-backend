/**
 * Word packs for the party games.
 *
 * SOURCE AND LICENCE: written for Dyce by the project as original, everyday vocabulary (common foods,
 * animals, places, objects, jobs and Nigerian street and food life). Nothing is copied or filtered from a
 * third-party list, so there is no external licence to carry. No brand names, no proper names of
 * people, nothing hyphenated. Every entry passes `isCleanText` (tested), and an English-or-Naija reader
 * should be able to draw, act or hint it in a sentence.
 *
 * LIMITS: small on purpose (they ship in the app bundle and in the state of a running match). A match
 * copies the words it needs into its own state at `init`, so editing a pack never changes a running match;
 * it does change what a given seed deals, so a changed pack needs a new `WORD_PACKS_VERSION`.
 */
export const WORD_PACKS_VERSION = 'dyce-party-v1';

export type WordPack = { id: string; label: string; words: readonly string[] };

const split = (s: string): string[] =>
  s
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w.length > 0);

/** Nouns that can be drawn (Doodle Guess) and hinted around (Imposter). */
export const WORD_PACKS: Readonly<Record<string, WordPack>> = {
  general: {
    id: 'general',
    label: 'Everyday things',
    words: split(`umbrella, bicycle, candle, window, ladder, pillow, mirror, bucket, clock, kite,
      guitar, drum, scissors, key, lamp, bridge, tent, balloon, camera, envelope, bottle, shoe,
      glasses, book, hammer, backpack, fan, chair, door, phone, football, rope, battery, comb,
      toothbrush, table, ring, boat, bell, flag`),
  },
  food: {
    id: 'food',
    label: 'Food and drink',
    words:
      split(`pizza, burger, banana, pineapple, watermelon, sandwich, ice cream, popcorn, pancake,
      egg, bread, cake, carrot, tomato, onion, pepper, mango, orange, coconut, cheese, noodles, soup,
      spaghetti, cucumber, honey, milk, coffee, cookie, chocolate, avocado, lemon, sugar, salt, rice,
      beans, fish pie, doughnut, lollipop, corn, peanut`),
  },
  animals: {
    id: 'animals',
    label: 'Animals',
    words: split(`elephant, giraffe, lion, monkey, crocodile, snake, tortoise, goat, chicken, cow,
      horse, donkey, rabbit, frog, butterfly, spider, bee, ant, fish, shark, whale, dolphin, owl, eagle,
      parrot, camel, zebra, hippo, snail, crab, bat, duck, cat, dog, pig, sheep, mouse, turkey, lizard,
      squirrel`),
  },
  places: {
    id: 'places',
    label: 'Places',
    words: split(`airport, market, school, hospital, church, mosque, beach, bank, stadium, bus stop,
      petrol station, police station, cinema, hotel, farm, island, mountain, river, forest, desert,
      village, lagoon, library, bakery, barber shop, salon, garage, post office, zoo, museum, park,
      roundabout, bridge, tollgate, football pitch, restaurant, supermarket, factory, prison, palace`),
  },
  naija: {
    id: 'naija',
    label: 'Naija',
    words: split(`jollof rice, suya, danfo, okada, keke, agbada, gele, ankara, puff puff, moi moi,
      akara, egusi soup, pounded yam, plantain, dodo, zobo, chin chin, garri, ofada rice, agege bread,
      generator, pure water, mosquito net, palm tree, talking drum, calabash, wrapper, face cap,
      Lagos traffic, owambe, bukka, mama put, ewa agoyin, kilishi, roasted corn, bolekaja, suya spot,
      oha soup, yam and egg, cow leg`),
  },
};

/** Packs for Doodle Guess and Imposter when a match does not name one: all of them. */
export const DEFAULT_PACK_IDS: readonly string[] = [
  'general',
  'food',
  'animals',
  'places',
  'naija',
];

/** The words of the named packs, in a fixed order, de-duplicated. Throws on an unknown id. */
export function packWords(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const id of ids) {
    const pack = WORD_PACKS[id];
    if (!pack) throw new Error(`Unknown word pack ${id}`);
    for (const w of pack.words) if (!out.includes(w)) out.push(w);
  }
  return out;
}

export const packLabel = (ids: readonly string[]): string =>
  ids.map((id) => WORD_PACKS[id]?.label ?? id).join(' + ');

// ---------------------------------------------------------------------------------------------
// Charades prompts: things to act out (people, actions, scenes), each with a category.

export type CharadesPrompt = { c: string; t: string };
export type CharadesPack = { id: string; label: string; prompts: readonly string[] };

export const CHARADES_PACKS: Readonly<Record<string, CharadesPack>> = {
  'lagos-life': {
    id: 'lagos-life',
    label: 'Lagos life',
    prompts:
      split(`Danfo driver, Keke rider, Bus conductor, Agbero collecting money, Selling pure water
      in traffic, Waiting for NEPA to bring light, Fuelling a generator, Dancing at an owambe,
      Spraying money, Bargaining at the market, Running for a danfo, Hawking plantain chips,
      Sleeping in traffic, Roasting corn, Pounding yam, Frying puff puff, Tailor taking measurements,
      Praying in church, Washing clothes by hand, Carrying a basket on the head`),
  },
  animals: {
    id: 'animals',
    label: 'Animals',
    prompts: split(`Monkey, Elephant, Chicken, Goat, Snake, Crocodile, Tortoise, Lion, Frog, Bat,
      Butterfly, Giraffe, Horse, Dog chasing a ball, Cat stretching, Fish swimming, Eagle flying,
      Camel walking, Sleeping bear, Hen laying an egg`),
  },
  jobs: {
    id: 'jobs',
    label: 'Jobs',
    prompts: split(`Doctor, Teacher, Pilot, Footballer, Barber, Mechanic, Farmer, Police officer,
      Fisherman, Chef, Singer, Dentist, Photographer, Firefighter, Referee, Painter, Bricklayer,
      Newsreader, Judge, Hairdresser`),
  },
  actions: {
    id: 'actions',
    label: 'Actions',
    prompts: split(`Brushing teeth, Climbing a ladder, Riding a bicycle, Playing the drums, Cooking
      jollof rice, Taking a selfie, Sneezing, Swimming, Skipping rope, Playing football, Washing a car,
      Painting a wall, Flying a kite, Fishing, Texting while walking, Lifting weights, Shivering in
      the cold, Crying with laughter, Sweeping the floor, Chasing a mosquito`),
  },
};

export const DEFAULT_CHARADES_PACK_IDS: readonly string[] = [
  'lagos-life',
  'animals',
  'jobs',
  'actions',
];

export function charadesPrompts(ids: readonly string[]): CharadesPrompt[] {
  const out: CharadesPrompt[] = [];
  for (const id of ids) {
    const pack = CHARADES_PACKS[id];
    if (!pack) throw new Error(`Unknown charades pack ${id}`);
    for (const t of pack.prompts) out.push({ c: pack.label, t });
  }
  return out;
}
