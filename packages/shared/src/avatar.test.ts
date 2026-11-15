import {
  AVATAR_PRESET_COUNT,
  avatarConfigSchema,
  avatarPresetId,
  parseAvatar,
  setAvatarSchema,
} from './schemas/avatar.ts';

describe('starter look ids', () => {
  it('are dyce_av_001 to dyce_av_220', () => {
    expect(avatarPresetId(1)).toBe('dyce_av_001');
    expect(avatarPresetId(42)).toBe('dyce_av_042');
    expect(avatarPresetId(AVATAR_PRESET_COUNT)).toBe('dyce_av_220');
  });

  it('accept every real look and nothing outside the 220', () => {
    for (let n = 1; n <= AVATAR_PRESET_COUNT; n++) {
      expect(avatarConfigSchema.safeParse({ v: 1, preset: avatarPresetId(n) }).success).toBe(true);
    }
    for (const preset of ['dyce_av_000', 'dyce_av_221', 'dyce_av_999', 'dyce_av_1', 'x', '']) {
      expect(avatarConfigSchema.safeParse({ v: 1, preset }).success).toBe(false);
    }
  });
});

describe('avatar config', () => {
  it('is v1 with a preset and nothing else', () => {
    expect(avatarConfigSchema.safeParse({ v: 1, preset: 'dyce_av_007' }).success).toBe(true);
    expect(avatarConfigSchema.safeParse({ v: 2, preset: 'dyce_av_007' }).success).toBe(false);
    expect(
      avatarConfigSchema.safeParse({ v: 1, preset: 'dyce_av_007', url: 'http://x' }).success,
    ).toBe(false);
    expect(setAvatarSchema.safeParse({ avatar: { v: 1, preset: 'dyce_av_007' } }).success).toBe(
      true,
    );
    expect(setAvatarSchema.safeParse({ preset: 'dyce_av_007' }).success).toBe(false);
  });

  it('parseAvatar treats an empty or invalid stored value as "no avatar"', () => {
    expect(parseAvatar({})).toBeNull();
    expect(parseAvatar(null)).toBeNull();
    expect(parseAvatar({ v: 1, preset: 'dyce_av_999' })).toBeNull();
    expect(parseAvatar({ v: 1, preset: 'dyce_av_012' })).toEqual({ v: 1, preset: 'dyce_av_012' });
  });
});
