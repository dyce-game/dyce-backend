import { createMatchSchema } from './schemas/games.ts';

const base = {
  id: '5b1f9a62-3c4d-4e8a-9d71-0f6a2b7c8d90',
  conversationId: 'a3c1d7e4-6b2f-4f0a-8e55-1d2c3b4a5f60',
};

describe('createMatchSchema game slugs', () => {
  it('accepts every engine slug, hyphens included', () => {
    for (const slug of ['_example', 'word-hunt', 'cup-pong', 'whot', 'sea_battle']) {
      expect(createMatchSchema.safeParse({ ...base, gameSlug: slug }).success).toBe(true);
    }
  });

  it('refuses anything that is not a slug', () => {
    for (const slug of ['', 'Word Hunt', 'word.hunt', 'WORD-HUNT', 'a/b', 'x'.repeat(41)]) {
      expect(createMatchSchema.safeParse({ ...base, gameSlug: slug }).success).toBe(false);
    }
  });
});
