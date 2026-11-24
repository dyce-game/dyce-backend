import { parseReviewLogins, reviewKey } from './review-logins.ts';

describe('review logins (App Review demo accounts)', () => {
  it('is empty when not set', () => {
    expect(parseReviewLogins(undefined).codes.size).toBe(0);
    expect(parseReviewLogins('  ').errors).toEqual([]);
  });

  it('reads phone and email entries, normalised', () => {
    const r = parseReviewLogins('+234 803 412 7781=482913; Review@Mail.Dyce.Games=739104');
    expect(r.errors).toEqual([]);
    expect(r.codes.get(reviewKey('phone', '+2348034127781'))).toBe('482913');
    expect(r.codes.get(reviewKey('email', 'review@mail.dyce.games'))).toBe('739104');
  });

  it('refuses a malformed or guessable entry, with a reason', () => {
    expect(parseReviewLogins('+2348034127781').errors[0]).toMatch(/identity=123456/);
    expect(parseReviewLogins('+2348034127781=12345').errors[0]).toMatch(/6 digits/);
    expect(parseReviewLogins('+2348034127781=111111').errors[0]).toMatch(/guessable/);
    expect(parseReviewLogins('+2348034127781=123456').errors[0]).toMatch(/guessable/);
    expect(parseReviewLogins('not-a-number=482913').errors[0]).toMatch(/international/);
    expect(parseReviewLogins('nobody@@x=482913').errors[0]).toMatch(/valid email/);
  });

  it('allows only a few', () => {
    const many = Array.from({ length: 5 }, (_, i) => `+23480341277${i}0=48291${i}`).join(';');
    expect(parseReviewLogins(many).errors.join()).toMatch(/at most 4/);
  });
});
