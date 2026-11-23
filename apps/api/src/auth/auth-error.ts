export type AuthErrorCode =
  | 'validation_failed'
  | 'invalid_phone'
  | 'otp_resend_too_soon'
  | 'otp_rate_limited'
  | 'otp_invalid'
  | 'otp_expired'
  | 'otp_locked'
  | 'sms_failed'
  | 'invalid_refresh'
  | 'refresh_reused'
  | 'account_disabled'
  | 'unauthorized'
  | 'profile_required'
  | 'profile_exists'
  | 'username_taken'
  | 'username_reserved'
  | 'age_already_set'
  // social: contacts and friend requests
  | 'contacts_rate_limited'
  | 'friend_requests_rate_limited'
  | 'user_not_found'
  | 'blocked'
  | 'requests_closed'
  | 'cannot_add_self'
  | 'friend_request_not_found'
  // messaging
  | 'conversation_not_found'
  | 'message_id_taken'
  | 'request_pending'
  | 'message_requests_rate_limited'
  // groups, bots, message actions
  | 'not_group_admin'
  | 'group_full'
  | 'group_id_taken'
  | 'group_member_not_friend'
  | 'groups_rate_limited'
  | 'message_not_found'
  | 'cannot_delete_message'
  | 'delete_window_closed'
  | 'invalid_vote'
  | 'not_a_group'
  | 'last_admin'
  // wallet
  | 'recipient_not_reachable'
  | 'transaction_not_found'
  // safety
  | 'reports_rate_limited'
  // games
  | 'game_not_found'
  | 'match_not_found'
  | 'match_requires_friends'
  | 'pool_not_available'
  | 'pool_not_supported'
  | 'invalid_stake'
  | 'counter_not_allowed'
  | 'opponent_cannot_stake'
  | 'match_not_open'
  | 'cannot_accept_own_invite'
  | 'open_invites_limit'
  | 'not_your_turn'
  | 'stale_version'
  | 'invalid_action'
  | 'illegal_move'
  // spaces
  | 'space_not_found'
  | 'space_id_taken'
  | 'space_full'
  | 'space_not_open'
  | 'space_live'
  | 'space_friends_only'
  | 'space_removed'
  | 'not_space_host'
  | 'not_enough_players'
  | 'invalid_seats'
  | 'invalid_payout'
  | 'spaces_limit'
  | 'room_unavailable'
  | 'invalid_options'
  | 'resign_not_supported'
  | 'dispute_not_allowed'
  | 'dispute_window_closed'
  | 'dispute_exists'
  | 'disputes_rate_limited'
  | 'username_mismatch'
  // quick match
  | 'quick_match_unavailable'
  | 'quick_match_active'
  | 'quick_match_not_found'
  | 'quick_match_expired'
  | 'quick_match_rate_limited'
  | 'quick_match_cooldown'
  // invites and the guest web game
  | 'invite_not_found'
  | 'invite_expired'
  | 'invite_used'
  | 'already_on_dyce'
  | 'invite_rate_limited'
  | 'invite_number_limited'
  | 'invite_too_soon'
  | 'guest_unauthorized'
  | 'guest_already_played'
  | 'guest_game_unavailable'
  // discovery and notifications
  | 'search_rate_limited'
  // trust and safety (ADR-039)
  | 'account_suspended'
  | 'account_muted'
  | 'integrity_check_failed'
  | 'money_requests_rate_limited'
  | 'stranger_scans_rate_limited';

const STATUS: Record<AuthErrorCode, number> = {
  validation_failed: 422,
  invalid_phone: 422,
  otp_resend_too_soon: 429,
  otp_rate_limited: 429,
  otp_invalid: 400,
  otp_expired: 400,
  otp_locked: 429,
  sms_failed: 502,
  invalid_refresh: 401,
  refresh_reused: 401,
  account_disabled: 403,
  unauthorized: 401,
  profile_required: 409,
  profile_exists: 409,
  username_taken: 409,
  username_reserved: 422,
  age_already_set: 409,
  contacts_rate_limited: 429,
  friend_requests_rate_limited: 429,
  user_not_found: 404,
  blocked: 403,
  requests_closed: 403,
  cannot_add_self: 422,
  friend_request_not_found: 404,
  conversation_not_found: 404,
  message_id_taken: 409,
  request_pending: 429,
  message_requests_rate_limited: 429,
  not_group_admin: 403,
  group_full: 409,
  group_id_taken: 409,
  group_member_not_friend: 403,
  groups_rate_limited: 429,
  message_not_found: 404,
  cannot_delete_message: 403,
  delete_window_closed: 409,
  invalid_vote: 422,
  not_a_group: 409,
  last_admin: 409,
  recipient_not_reachable: 403,
  transaction_not_found: 404,
  reports_rate_limited: 429,
  game_not_found: 404,
  match_not_found: 404,
  match_requires_friends: 403,
  pool_not_available: 422,
  pool_not_supported: 422,
  invalid_stake: 422,
  counter_not_allowed: 409,
  opponent_cannot_stake: 409,
  match_not_open: 409,
  cannot_accept_own_invite: 403,
  open_invites_limit: 429,
  not_your_turn: 409,
  stale_version: 409,
  invalid_action: 422,
  illegal_move: 422,
  space_not_found: 404,
  space_id_taken: 409,
  space_full: 409,
  space_not_open: 409,
  space_live: 409,
  space_friends_only: 403,
  space_removed: 403,
  not_space_host: 403,
  not_enough_players: 409,
  invalid_seats: 422,
  invalid_payout: 422,
  spaces_limit: 429,
  room_unavailable: 503,
  invalid_options: 422,
  resign_not_supported: 409,
  dispute_not_allowed: 403,
  dispute_window_closed: 409,
  dispute_exists: 409,
  disputes_rate_limited: 429,
  username_mismatch: 422,
  quick_match_unavailable: 422,
  quick_match_active: 409,
  quick_match_not_found: 404,
  quick_match_expired: 410,
  quick_match_rate_limited: 429,
  quick_match_cooldown: 429,
  invite_not_found: 404,
  invite_expired: 410,
  invite_used: 410,
  already_on_dyce: 409,
  invite_rate_limited: 429,
  invite_number_limited: 429,
  invite_too_soon: 429,
  guest_unauthorized: 401,
  guest_already_played: 409,
  guest_game_unavailable: 422,
  search_rate_limited: 429,
  account_suspended: 403,
  account_muted: 403,
  integrity_check_failed: 403,
  money_requests_rate_limited: 429,
  stranger_scans_rate_limited: 429,
};

/** An expected, user-facing failure. Mapped to `{ code, message, ...details }` by the HTTP filter. */
export class AuthError extends Error {
  readonly code: AuthErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(code: AuthErrorCode, details: Record<string, unknown> = {}) {
    super(code);
    this.name = 'AuthError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}
