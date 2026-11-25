import { z } from 'zod';
import { CONTENT_BLOCKED, isContentAllowed } from '../content-filter.ts';
import { BOT_SLUGS } from '../bots.ts';
import type { PublicUser } from './contacts.ts';
import type { GroupRole, ReactionKey } from './messages.ts';
import { reactionKeySchema } from './messages.ts';

/** Group rules (SPEC §6: up to 50 members, name and photo). The server reads the same limits from `app_config`. */
export const MAX_GROUP_MEMBERS = 50;
export const MIN_GROUP_OTHERS = 2;
export const MAX_GROUP_TITLE_LENGTH = 40;
/** How long after sending you can delete a message for everyone. */
export const DELETE_FOR_EVERYONE_MINUTES = 15;

const titleSchema = z
  .string()
  .trim()
  .min(1)
  .max(MAX_GROUP_TITLE_LENGTH)
  .refine((s) => isContentAllowed(s, 'name'), CONTENT_BLOCKED);

/** The client picks the conversation id, so a retried "Create" can't make two groups. */
export const createGroupSchema = z.object({
  id: z.uuid(),
  title: titleSchema,
  /** The other people (friends of yours); you are added as the admin. */
  memberIds: z
    .array(z.uuid())
    .min(MIN_GROUP_OTHERS)
    .max(MAX_GROUP_MEMBERS - 1),
});
export type CreateGroupRequest = z.infer<typeof createGroupSchema>;

export const renameGroupSchema = z.object({ title: titleSchema });
export type RenameGroupRequest = z.infer<typeof renameGroupSchema>;

export const addMembersSchema = z.object({
  userIds: z
    .array(z.uuid())
    .min(1)
    .max(MAX_GROUP_MEMBERS - 1),
});
export type AddMembersRequest = z.infer<typeof addMembersSchema>;

export const setRoleSchema = z.object({ role: z.enum(['admin', 'member']) });
export type SetRoleRequest = z.infer<typeof setRoleSchema>;

export const groupMemberParamSchema = z.object({ id: z.uuid(), userId: z.uuid() });

/** One person in a group. `state: 'left'` is someone who left or was removed (their old messages keep their name). */
export type GroupMember = {
  user: PublicUser;
  role: GroupRole;
  state: 'active' | 'left';
  joinedAt: string;
};
export type GroupMembersResponse = { members: GroupMember[] };

// ---- polls ---------------------------------------------------------------------------------------

export const MAX_POLL_OPTIONS = 6;
export const MIN_POLL_OPTIONS = 2;
export const MAX_POLL_QUESTION_LENGTH = 120;
export const MAX_POLL_OPTION_LENGTH = 60;

export const createPollSchema = z.object({
  /** The message id, chosen by the client so a retry can't post it twice. */
  id: z.uuid(),
  question: z
    .string()
    .trim()
    .min(1)
    .max(MAX_POLL_QUESTION_LENGTH)
    .refine((s) => isContentAllowed(s, 'name'), CONTENT_BLOCKED),
  options: z
    .array(
      z
        .string()
        .trim()
        .min(1)
        .max(MAX_POLL_OPTION_LENGTH)
        .refine((s) => isContentAllowed(s, 'name'), CONTENT_BLOCKED),
    )
    .min(MIN_POLL_OPTIONS)
    .max(MAX_POLL_OPTIONS),
});
export type CreatePollRequest = z.infer<typeof createPollSchema>;

/** `optionId: null` takes your vote back. */
export const votePollSchema = z.object({
  optionId: z
    .number()
    .int()
    .min(0)
    .max(MAX_POLL_OPTIONS - 1)
    .nullable(),
});
export type VotePollRequest = z.infer<typeof votePollSchema>;

// ---- reactions and deletes -----------------------------------------------------------------------

/** `reaction: null` takes yours back. Reacting again replaces your previous reaction. */
export const reactSchema = z.object({ reaction: reactionKeySchema.nullable() });
export type ReactRequest = { reaction: ReactionKey | null };

export const deleteMessageQuerySchema = z.object({
  scope: z.enum(['me', 'everyone']).default('me'),
});
export type DeleteMessageQuery = z.infer<typeof deleteMessageQuerySchema>;

export const messageParamSchema = z.object({ id: z.uuid(), messageId: z.uuid() });

export const botSlugParamSchema = z.object({ slug: z.enum(BOT_SLUGS) });
