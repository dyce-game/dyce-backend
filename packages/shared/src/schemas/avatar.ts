import { z } from 'zod';

/**
 * Avatars (docs/AVATAR_GUIDEBOOK.md). Phase A: every player picks one of the 220 starter looks, stored as
 * `{ v: 1, preset: 'dyce_av_042' }`. Phase B adds `v: 2` (the editable 3D rig); a v1 preset is then migrated to the
 * matching v2 config. The v2 schema waits for the artist's part manifest, so it is not here yet.
 */
export const AVATAR_PRESET_COUNT = 220;

/** `dyce_av_001` ... `dyce_av_220`. */
export function avatarPresetId(n: number): string {
  return `dyce_av_${String(n).padStart(3, '0')}`;
}

export const avatarPresetIdSchema = z
  .string()
  .regex(/^dyce_av_\d{3}$/, 'Not a starter look')
  .refine((id) => {
    const n = Number(id.slice(8));
    return n >= 1 && n <= AVATAR_PRESET_COUNT;
  }, 'Not a starter look');

export const avatarConfigV1Schema = z
  .object({ v: z.literal(1), preset: avatarPresetIdSchema })
  .strict();
export type AvatarConfigV1 = z.infer<typeof avatarConfigV1Schema>;

/** Everything an avatar can be today. Grows a `v: 2` member in Phase B. */
export const avatarConfigSchema = avatarConfigV1Schema;
export type AvatarConfig = AvatarConfigV1;

export const setAvatarSchema = z.object({ avatar: avatarConfigSchema }).strict();
export type SetAvatarRequest = z.infer<typeof setAvatarSchema>;

/**
 * Reads a stored avatar (`profiles.avatar`, `{}` until one is chosen). Anything that isn't a valid config is
 * "no avatar" rather than an error, so one bad row never breaks a list.
 */
export function parseAvatar(value: unknown): AvatarConfig | null {
  const r = avatarConfigSchema.safeParse(value);
  return r.success ? r.data : null;
}
