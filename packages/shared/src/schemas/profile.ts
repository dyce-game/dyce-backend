import { z } from 'zod';

/** Who may send you a friend request or a first message: everyone, friends of friends, or nobody. */
export const REQUEST_POLICIES = ['everyone', 'fof', 'nobody'] as const;
export const requestPolicySchema = z.enum(REQUEST_POLICIES);
export type RequestPolicy = z.infer<typeof requestPolicySchema>;

export const MAX_DISPLAY_NAME_LENGTH = 40;

/**
 * Edit your profile (Edit profile, Settings). Every field is optional but at least one must be sent.
 * The username can't be changed yet (it needs the cooldown and reservation rules; see BACKLOG).
 */
export const profileUpdateSchema = z
  .object({
    displayName: z.string().trim().min(1, 'Enter a name').max(MAX_DISPLAY_NAME_LENGTH).optional(),
    requestPolicy: requestPolicySchema.optional(),
  })
  .strict()
  .refine((v) => v.displayName !== undefined || v.requestPolicy !== undefined, {
    message: 'Nothing to change',
  });
export type ProfileUpdate = z.infer<typeof profileUpdateSchema>;
