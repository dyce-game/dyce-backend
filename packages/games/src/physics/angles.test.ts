import { FULL_TURN_CENTI, sinCosCenti, wrapCenti } from './angles.ts';

describe('physics/angles: deterministic sin/cos', () => {
  it('is exact at the cardinal directions', () => {
    expect(sinCosCenti(0)).toEqual([0, 1]);
    expect(sinCosCenti(9000)).toEqual([1, -0]);
    expect(sinCosCenti(18000)).toEqual([-0, -1]);
    expect(sinCosCenti(27000)).toEqual([-1, 0]);
  });

  it('matches Math.sin / Math.cos to 1e-12 over every centidegree', () => {
    for (let a = 0; a < FULL_TURN_CENTI; a++) {
      const [s, c] = sinCosCenti(a);
      const r = (a * Math.PI) / 18000;
      expect(Math.abs(s - Math.sin(r))).toBeLessThan(1e-12);
      expect(Math.abs(c - Math.cos(r))).toBeLessThan(1e-12);
    }
  });

  it('wraps negative and large angles', () => {
    expect(wrapCenti(-100)).toBe(35900);
    expect(wrapCenti(36000 + 5)).toBe(5);
    expect(sinCosCenti(-4500)).toEqual(sinCosCenti(31500));
  });

  it('is a unit vector', () => {
    for (const a of [1, 777, 4499, 4501, 12345, 35999]) {
      const [s, c] = sinCosCenti(a);
      expect(Math.abs(s * s + c * c - 1)).toBeLessThan(1e-14);
    }
  });
});
