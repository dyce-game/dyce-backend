import {
  isCleanText,
  normaliseText,
  oneEditApart,
  placementsByScore,
  sideResult,
} from './common.ts';
import { CHARADES_PACKS, WORD_PACKS, charadesPrompts, packWords } from './words.ts';

describe('word packs', () => {
  it('every word and prompt passes the profanity check', () => {
    for (const pack of Object.values(WORD_PACKS)) {
      for (const w of pack.words) expect([pack.id, w, isCleanText(w)]).toEqual([pack.id, w, true]);
    }
    for (const pack of Object.values(CHARADES_PACKS)) {
      for (const w of pack.prompts)
        expect([pack.id, w, isCleanText(w)]).toEqual([pack.id, w, true]);
    }
  });

  it('packs are the right size, trimmed and free of repeats', () => {
    for (const pack of Object.values(WORD_PACKS)) {
      expect(pack.words.length).toBeGreaterThanOrEqual(30);
      expect(new Set(pack.words).size).toBe(pack.words.length);
      for (const w of pack.words) expect(w).toBe(w.trim());
    }
    for (const pack of Object.values(CHARADES_PACKS)) {
      expect(pack.prompts.length).toBeGreaterThanOrEqual(15);
      expect(new Set(pack.prompts).size).toBe(pack.prompts.length);
    }
    expect(WORD_PACKS['naija']!.words).toContain('jollof rice');
    expect(CHARADES_PACKS['lagos-life']!.prompts).toContain('Danfo driver');
  });

  it('packWords de-duplicates across packs and rejects unknown ids', () => {
    const all = packWords(['general', 'places']);
    expect(new Set(all).size).toBe(all.length);
    expect(() => packWords(['nope'])).toThrow();
    expect(charadesPrompts(['jobs'])[0]).toEqual({ c: 'Jobs', t: 'Doctor' });
  });
});

describe('profanity check and text helpers', () => {
  it('catches bad words as tokens and stems, but not innocent words that contain them', () => {
    expect(isCleanText('what the fuck')).toBe(false);
    expect(isCleanText('Shitty')).toBe(false);
    expect(isCleanText('sex')).toBe(false);
    expect(isCleanText('c.u.m')).toBe(true);
    expect(isCleanText('class assignment')).toBe(true);
    expect(isCleanText('Scunthorpe cocktail')).toBe(true);
    expect(isCleanText('suya and rice')).toBe(true);
  });

  it('normalises and measures near misses', () => {
    expect(normaliseText(' Fried  Rice! ')).toBe('friedrice');
    expect(oneEditApart('jollof', 'jollov')).toBe(true);
    expect(oneEditApart('jollof', 'jolof')).toBe(true);
    expect(oneEditApart('jollof', 'jolloff')).toBe(true);
    expect(oneEditApart('jollof', 'jollof')).toBe(false);
    expect(oneEditApart('jollof', 'jolo')).toBe(false);
  });

  it('result helpers rank by score and by side', () => {
    expect(placementsByScore(['a', 'b', 'c'], (p) => ({ a: 5, b: 9, c: 5 })[p]!)).toEqual({
      placements: [['b'], ['a', 'c']],
      draw: false,
    });
    expect(placementsByScore(['a', 'b'], () => 1).draw).toBe(true);
    expect(sideResult(['a'], ['b', 'c'])).toEqual({ placements: [['a'], ['b', 'c']], draw: false });
  });
});
