import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  addMembersSchema,
  botSlugParamSchema,
  conversationIdParamSchema,
  createGroupSchema,
  createPollSchema,
  deleteMessageQuerySchema,
  groupMemberParamSchema,
  listConversationsQuerySchema,
  messageParamSchema,
  messagesQuerySchema,
  openDirectSchema,
  reactSchema,
  renameGroupSchema,
  sendMessageSchema,
  setRoleSchema,
  votePollSchema,
  type AddMembersRequest,
  type CreateGroupRequest,
  type CreatePollRequest,
  type MessagesQuery,
  type OpenDirectRequest,
  type RenameGroupRequest,
  type SendMessageRequest,
  type SetRoleRequest,
  type VotePollRequest,
} from '@dyce/shared';
import type { z } from 'zod';
import { AuthGuard, CurrentUser, type AuthContext } from '../auth/auth.guard.ts';
import { ZodPipe } from '../common/zod.pipe.ts';
import { GroupsService } from './groups.service.ts';
import { MessageActionsService } from './message-actions.service.ts';
import { MessagesService } from './messages.service.ts';

const idPipe = new ZodPipe(conversationIdParamSchema);

@Controller('conversations')
@UseGuards(AuthGuard)
export class ChatController {
  constructor(
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(GroupsService) private readonly groups: GroupsService,
    @Inject(MessageActionsService) private readonly actions: MessageActionsService,
  ) {}

  /** `?filter=all|friends|groups|requests|bots` */
  @Get()
  list(
    @CurrentUser() user: AuthContext,
    @Query(new ZodPipe(listConversationsQuerySchema))
    query: z.output<typeof listConversationsQuerySchema>,
  ) {
    return this.messages.list(user.userId, query.filter);
  }

  /** Opens (or creates) your conversation with one person. Sends nothing. */
  @Post('direct')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  openDirect(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(openDirectSchema)) body: OpenDirectRequest,
  ) {
    return this.messages.openDirect(user.userId, body.userId);
  }

  /** Your chat with one of the practice bots (created with its greeting the first time). */
  @Post('bots/:slug')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  async openBot(
    @CurrentUser() user: AuthContext,
    @Param(new ZodPipe(botSlugParamSchema)) params: z.output<typeof botSlugParamSchema>,
  ) {
    const id = await this.messages.bots.open(user.userId, params.slug);
    return this.messages.get(user.userId, id);
  }

  /** A new group of you and your friends. The client picks the id, so retrying is safe. */
  @Post('groups')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60_000 } })
  createGroup(
    @CurrentUser() user: AuthContext,
    @Body(new ZodPipe(createGroupSchema)) body: CreateGroupRequest,
  ) {
    return this.groups.create(user.userId, body);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.messages.get(user.userId, id);
  }

  /** Admins rename the group. */
  @Patch(':id')
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  rename(
    @CurrentUser() user: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(renameGroupSchema)) body: RenameGroupRequest,
  ) {
    return this.groups.rename(user.userId, id, body.title);
  }

  /** Newest first; pass the returned `nextCursor` as `before` for older ones. */
  @Get(':id/messages')
  history(
    @CurrentUser() user: AuthContext,
    @Param('id', idPipe) id: string,
    @Query(new ZodPipe(messagesQuerySchema)) query: MessagesQuery,
  ) {
    return this.messages.messages(user.userId, id, query);
  }

  /** The client chooses the message id, so retrying a failed send is safe. */
  @Post(':id/messages')
  @HttpCode(200)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  send(
    @CurrentUser() user: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(sendMessageSchema)) body: SendMessageRequest,
  ) {
    return this.messages.send(user.userId, id, body);
  }

  /** `?scope=me|everyone` (everyone: your own text or poll, within 15 minutes). */
  @Delete(':id/messages/:messageId')
  @HttpCode(204)
  @Throttle({ default: { limit: 60, ttl: 60_000 } })
  async deleteMessage(
    @CurrentUser() user: AuthContext,
    @Param(new ZodPipe(messageParamSchema)) params: z.output<typeof messageParamSchema>,
    @Query(new ZodPipe(deleteMessageQuerySchema)) query: z.output<typeof deleteMessageQuerySchema>,
  ): Promise<void> {
    await this.actions.delete(user.userId, params.id, params.messageId, query.scope);
  }

  /** Your reaction to a message (`{ reaction: null }` removes it). */
  @Put(':id/messages/:messageId/reaction')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  async react(
    @CurrentUser() user: AuthContext,
    @Param(new ZodPipe(messageParamSchema)) params: z.output<typeof messageParamSchema>,
    @Body(new ZodPipe(reactSchema)) body: z.output<typeof reactSchema>,
  ) {
    const reactions = await this.actions.react(
      user.userId,
      params.id,
      params.messageId,
      body.reaction,
    );
    return { reactions };
  }

  /** A poll in a group. */
  @Post(':id/polls')
  @HttpCode(200)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  createPoll(
    @CurrentUser() user: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(createPollSchema)) body: CreatePollRequest,
  ) {
    return this.actions.createPoll(user.userId, id, body);
  }

  /** Your vote in a poll (`{ optionId: null }` takes it back). */
  @Put(':id/messages/:messageId/vote')
  @Throttle({ default: { limit: 120, ttl: 60_000 } })
  vote(
    @CurrentUser() user: AuthContext,
    @Param(new ZodPipe(messageParamSchema)) params: z.output<typeof messageParamSchema>,
    @Body(new ZodPipe(votePollSchema)) body: VotePollRequest,
  ) {
    return this.actions.vote(user.userId, params.id, params.messageId, body.optionId);
  }

  @Get(':id/members')
  members(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.groups.members(user.userId, id);
  }

  /** Admins add their friends. */
  @Post(':id/members')
  @HttpCode(200)
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  addMembers(
    @CurrentUser() user: AuthContext,
    @Param('id', idPipe) id: string,
    @Body(new ZodPipe(addMembersSchema)) body: AddMembersRequest,
  ) {
    return this.groups.add(user.userId, id, body.userIds);
  }

  /** Admins remove a member (not another admin). */
  @Delete(':id/members/:userId')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  removeMember(
    @CurrentUser() user: AuthContext,
    @Param(new ZodPipe(groupMemberParamSchema)) params: z.output<typeof groupMemberParamSchema>,
  ) {
    return this.groups.remove(user.userId, params.id, params.userId);
  }

  /** Make a member an admin, or step down yourself. */
  @Put(':id/members/:userId/role')
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  setRole(
    @CurrentUser() user: AuthContext,
    @Param(new ZodPipe(groupMemberParamSchema)) params: z.output<typeof groupMemberParamSchema>,
    @Body(new ZodPipe(setRoleSchema)) body: SetRoleRequest,
  ) {
    return this.groups.setRole(user.userId, params.id, params.userId, body.role);
  }

  @Post(':id/leave')
  @HttpCode(204)
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  async leave(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string): Promise<void> {
    await this.groups.leave(user.userId, id);
  }

  @Post(':id/read')
  @HttpCode(200)
  read(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.messages.markRead(user.userId, id);
  }

  @Post(':id/accept')
  @HttpCode(200)
  accept(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string) {
    return this.messages.accept(user.userId, id);
  }

  /** "Decline": hides the request; the sender is not told. */
  @Post(':id/decline')
  @HttpCode(204)
  async decline(@CurrentUser() user: AuthContext, @Param('id', idPipe) id: string): Promise<void> {
    await this.messages.decline(user.userId, id);
  }
}
