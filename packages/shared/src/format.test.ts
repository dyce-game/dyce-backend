import { formatNaira } from './format.ts';
import { nairaToKobo, kobo } from './money.ts';

const n = nairaToKobo;

describe('formatNaira compact', () => {
  const table: [number, string][] = [
    [0, 'Ð0'],
    [950, 'Ð950'],
    [1_500, 'Ð1,500'],
    [9_999, 'Ð9,999'],
    [10_000, 'Ð10k'],
    [12_500, 'Ð12.5k'],
    [12_550, 'Ð12.5k'], // truncated, never overstated
    [200_000, 'Ð200k'],
    [999_999, 'Ð999.9k'],
    [1_000_000, 'Ð1m'],
    [1_200_000, 'Ð1.2m'],
    [25_000_000, 'Ð25m'],
  ];
  it.each(table)('Ð%i → %s', (naira, expected) => {
    expect(formatNaira(n(naira), { compact: true })).toBe(expected);
  });

  it('formats negatives with a leading minus', () => {
    expect(formatNaira(n(-12_500), { compact: true })).toBe('-Ð12.5k');
  });

  it('ignores sub-naira kobo in compact mode', () => {
    expect(formatNaira(kobo(150_099), { compact: true })).toBe('Ð1,500');
  });
});

describe('formatNaira full', () => {
  it('starting grant', () => {
    expect(formatNaira(n(200_000))).toBe('Ð200,000');
  });
  it('thousands separators', () => {
    expect(formatNaira(n(1_234_567))).toBe('Ð1,234,567');
  });
  it('shows kobo only when non-zero', () => {
    expect(formatNaira(kobo(150_050))).toBe('Ð1,500.50');
    expect(formatNaira(kobo(150_005))).toBe('Ð1,500.05');
    expect(formatNaira(kobo(150_000))).toBe('Ð1,500');
  });
  it('zero', () => {
    expect(formatNaira(kobo(0))).toBe('Ð0');
  });
});
