import { MAX_DISPLAY_NAME_LENGTH, profileUpdateSchema } from './schemas/profile.ts';

describe('profileUpdateSchema', () => {
  it('takes a name, a request policy, or both', () => {
    expect(profileUpdateSchema.safeParse({ displayName: '  Ada  ' })).toMatchObject({
      success: true,
      data: { displayName: 'Ada' },
    });
    expect(profileUpdateSchema.safeParse({ requestPolicy: 'fof' }).success).toBe(true);
    expect(
      profileUpdateSchema.safeParse({ displayName: 'Ada', requestPolicy: 'nobody' }).success,
    ).toBe(true);
  });

  it('refuses an empty change, a blank or too long name, unknown policies and extra fields', () => {
    expect(profileUpdateSchema.safeParse({}).success).toBe(false);
    expect(profileUpdateSchema.safeParse({ displayName: '   ' }).success).toBe(false);
    expect(
      profileUpdateSchema.safeParse({ displayName: 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1) })
        .success,
    ).toBe(false);
    expect(profileUpdateSchema.safeParse({ requestPolicy: 'friends' }).success).toBe(false);
    // the username can't be changed through this endpoint
    expect(
      profileUpdateSchema.safeParse({ displayName: 'Ada', username: 'new_name' }).success,
    ).toBe(false);
  });
});
