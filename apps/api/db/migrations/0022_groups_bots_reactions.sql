-- Group chats, bots, replies, reactions, deletes and polls (ADR-026).
--
-- `conversation_kind` ('direct','group','bot','sms'), `member_role`, `member_state` ('left' for leavers and
-- people removed from a group), `messages.reply_to`, `messages.deleted_at`, `reactions` and the `poll` /
-- `system` message kinds already exist (0002). This adds what they lack.

-- ---- groups and bots -----------------------------------------------------------------------------

ALTER TABLE conversations ADD COLUMN bot_slug text;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_group_title_chk
    CHECK (kind <> 'group' OR (title IS NOT NULL AND char_length(title) BETWEEN 1 AND 40)),
  ADD CONSTRAINT conversations_bot_chk
    CHECK ((kind = 'bot') = (bot_slug IS NOT NULL));

-- One conversation per person per bot. (`created_by` is that person.)
CREATE UNIQUE INDEX conversations_bot_idx ON conversations (created_by, bot_slug) WHERE kind = 'bot';

-- When someone (re)joined: a member only sees a group's history from then on. Direct and bot chats keep
-- everything, so existing rows are backfilled to the day the conversation began.
ALTER TABLE conversation_members ADD COLUMN joined_at timestamptz NOT NULL DEFAULT now();
UPDATE conversation_members m SET joined_at = c.created_at FROM conversations c WHERE c.id = m.conversation_id;

-- A group's "who is in it" and "who are the admins" lookups.
CREATE INDEX conversation_members_conv_idx ON conversation_members (conversation_id, state, joined_at);

-- ---- messages ------------------------------------------------------------------------------------

-- A message deleted for everyone keeps its row (so a thread shows "This message was deleted", replies
-- still point at something and reports keep their place) but loses its content, so a deleted text has no body.
ALTER TABLE messages DROP CONSTRAINT messages_text_body_chk;
ALTER TABLE messages
  ADD CONSTRAINT messages_text_body_chk
  CHECK (kind <> 'text' OR deleted_at IS NOT NULL OR (body IS NOT NULL AND char_length(body) BETWEEN 1 AND 4000));

-- A message sent by a bot has no user behind it (`sender_id` is null); the conversation says which bot.
-- System messages ("Tunde added Amaka") are sent by the person who did it.

CREATE INDEX messages_reply_idx ON messages (reply_to) WHERE reply_to IS NOT NULL;

-- "Delete for me": the message stays for everyone else.
CREATE TABLE message_hides (
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  hidden_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, message_id)
);

-- ---- reactions -----------------------------------------------------------------------------------

-- One reaction per person per message (the primary key), chosen from a fixed set of keys. The app draws
-- them as short labels (GG, HA, !!, ?, L), never as emoji.
ALTER TABLE reactions
  ADD CONSTRAINT reactions_key_chk CHECK (emoji IN ('gg', 'ha', 'wow', 'q', 'l')),
  ADD COLUMN created_at timestamptz NOT NULL DEFAULT now();
CREATE INDEX reactions_message_idx ON reactions (message_id);

-- ---- polls ---------------------------------------------------------------------------------------

-- The question and options live in `messages.payload`; this is who voted for which option (by index).
-- One vote per person per poll, changeable.
CREATE TABLE poll_votes (
  message_id  uuid NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  option_id   smallint NOT NULL CHECK (option_id BETWEEN 0 AND 5),
  voted_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (message_id, user_id)
);
CREATE INDEX poll_votes_option_idx ON poll_votes (message_id, option_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON message_hides, poll_votes TO dyce_api;

-- ---- config --------------------------------------------------------------------------------------

INSERT INTO app_config (key, value) VALUES
  ('group_max_members',            '50'),
  ('groups_created_per_day',       '10'),
  ('delete_for_everyone_minutes',  '15')
ON CONFLICT (key) DO NOTHING;
