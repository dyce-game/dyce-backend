import { CONTENT_BLOCKED, checkContent, isContentAllowed } from './content-filter.ts';

describe('objectionable text filter (Apple 1.2)', () => {
  it('leaves ordinary words, places and names alone', () => {
    for (const ok of [
      'Nigeria',
      'Nigerian jollof',
      'Niger Delta',
      'Scunthorpe',
      'class of 2026',
      'assassin',
      'Kikelomo',
      'Pedro',
      'Dickson',
      'spicy suya',
      'raccoon',
      'Chinko',
      'Adaeze Obi',
      'ada.o',
      'player_1337',
      'Who reading',
      'Oluwaseun',
      'cocktail',
      'Whot night',
      'Good game, well played!',
    ]) {
      expect([ok, isContentAllowed(ok, 'name'), isContentAllowed(ok, 'message')]).toEqual([
        ok,
        true,
        true,
      ]);
    }
  });

  it('blocks slurs and exploitation terms in names and in messages, through disguise', () => {
    for (const bad of [
      'nigga',
      'N1GG3R',
      'n i g g e r',
      'f.a.g.g.o.t',
      'child porn',
      'kill yourself',
      'KYS',
      'pedo',
      'k1ke',
    ]) {
      expect([bad, checkContent(bad, 'message').ok]).toEqual([bad, false]);
      expect([bad, checkContent(bad, 'name').ok]).toEqual([bad, false]);
    }
  });

  it('blocks profanity in names but lets friends talk', () => {
    for (const bad of ['fuck_you', 'sh1thead', 'b1tch', 'f.u.c.k', 'big.cunt', 'Ashawo']) {
      expect([bad, checkContent(bad, 'name').ok]).toEqual([bad, false]);
    }
    expect(checkContent('this game is shit lol', 'message').ok).toBe(true);
    expect(checkContent('this game is shit lol', 'name')).toEqual({
      ok: false,
      severity: 'profane',
    });
  });

  it('survives odd input', () => {
    expect(isContentAllowed('', 'name')).toBe(true);
    expect(isContentAllowed('   ', 'message')).toBe(true);
    expect(isContentAllowed('😀😀😀', 'message')).toBe(true);
    expect(isContentAllowed('a​b​c', 'name')).toBe(true);
    expect(CONTENT_BLOCKED.length).toBeGreaterThan(10);
  });
});
