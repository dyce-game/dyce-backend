import { z } from 'zod';
import { parseReviewLogins } from '../auth/review-logins.ts';

/** Treat empty strings (a blank line in .env) as "not set". */
const optional = <T extends z.ZodType>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema.optional());

const positiveInt = (def: number) => z.coerce.number().int().positive().default(def);

/** Validated at boot: the API refuses to start with missing or malformed configuration. */
export const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(3000),
    /** Connect as a login role that is a member of `dyce_api` (never a superuser). */
    DATABASE_URL: z.string().min(1),
    /** HS256 secret for access tokens. Colyseus verifies the same token. */
    JWT_SECRET: z.string().min(32),
    /** Server-side secret for hashing phone numbers and OTP codes. Rotating it breaks contact matching. */
    PHONE_HASH_SALT: z.string().min(32),
    JWT_ACCESS_TTL_SECONDS: positiveInt(900),
    REFRESH_TTL_DAYS: positiveInt(30),
    OTP_TTL_SECONDS: positiveInt(300),
    /** Non-production only: fixed 6-digit code, no SMS sent. For Maestro and local development. */
    OTP_TEST_CODE: optional(z.string().regex(/^\d{6}$/, 'OTP_TEST_CODE must be 6 digits')),
    /**
     * Demo accounts for Apple and Google review: `+2348012345678=482913;review@mail.dyce.games=739104`. Those
     * identities accept their own fixed code and nothing is sent to them. Allowed in production on purpose; see
     * auth/review-logins.ts and docs/APP_REVIEW_NOTES.md.
     */
    REVIEW_LOGINS: optional(z.string().max(400)),
    /** "console" prints codes (masked number) to the log; "real" sends through Termii/Twilio. */
    SMS_DRIVER: z.enum(['console', 'real']).default('console'),
    /** Email sign-in and sign-up (ADR-044). Off = the email routes answer 404 and the app hides the option. */
    EMAIL_AUTH_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** "console" prints codes (dev); "resend" sends through Resend (required in production when email sign-in is on). */
    EMAIL_DRIVER: z.enum(['console', 'resend']).default('console'),
    RESEND_API_KEY: optional(z.string().min(1)),
    /** The verified sending address: `Dyce <login@mail.dyce.games>` or a bare address on a domain verified in Resend. */
    EMAIL_FROM: optional(z.string().min(5).max(200)),
    EMAIL_REPLY_TO: optional(z.string().min(5).max(200)),
    /** Tests and proxies only; defaults to https://api.resend.com. */
    RESEND_BASE_URL: optional(z.url()),
    TERMII_API_KEY: optional(z.string().min(1)),
    TERMII_SENDER_ID: optional(z.string().min(1)),
    TERMII_BASE_URL: optional(z.url()),
    TERMII_CHANNEL: optional(z.enum(['dnd', 'generic', 'whatsapp'])),
    TWILIO_ACCOUNT_SID: optional(z.string().min(1)),
    TWILIO_AUTH_TOKEN: optional(z.string().min(1)),
    TWILIO_FROM: optional(z.string().min(1)),
    TWILIO_MESSAGING_SERVICE_SID: optional(z.string().min(1)),
    /** Comma-separated browser origins allowed to call the API (web guest game, local web dev). Empty = none. */
    CORS_ORIGINS: optional(z.string()),
    /** Where invite links point: the web build that hosts /i/<token> (https://dyce.games in production). */
    INVITE_BASE_URL: z.url().default('https://dyce.games'),
    /** Live Spaces: where the Colyseus game server listens for our signed room requests, and the public
     *  ws(s) URL handed to apps. Without INTERNAL_SECRET (>= 32 chars) rooms cannot be started. */
    GAME_SERVER_URL: optional(z.url()),
    GAME_SERVER_PUBLIC_URL: optional(z.string().regex(/^wss?:\/\//)),
    INTERNAL_SECRET: optional(z.string().min(32)),
    /** Push notifications: "console" prints them (dev); "expo" sends through the Expo Push API (required in production). */
    PUSH_DRIVER: z.enum(['console', 'expo']).default('console'),
    /** Optional Expo access token (enhanced push security). */
    EXPO_ACCESS_TOKEN: optional(z.string().min(1)),
    /** Device integrity at Pool entry (ADR-039): `dev` always passes (refused in production); `store` fails closed
     *  until the Play Integrity / App Attest verification is written. Only consulted when `integrity_required`. */
    INTEGRITY_DRIVER: z.enum(['dev', 'store']).default('dev'),
    /** The moderation API (ADR-039): a login role in `dyce_admin`, and `name:token,name:token` (tokens 32+ chars).
     *  Both must be set or the admin routes answer 404. */
    ADMIN_DATABASE_URL: optional(z.string().min(1)),
    ADMIN_TOKENS: optional(z.string().min(1)),
    /** Number of reverse-proxy hops to trust for client IPs (rate limiting). 0 = none. */
    TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

    // --- Operations (docs/RUNBOOK.md, docs/MONITORING.md) ---
    /** Git sha or version of this build; shown by /health/ready, tagged on logs and Sentry events. */
    RELEASE: optional(z.string().min(1)),
    LOG_LEVEL: z.enum(['error', 'warn', 'info', 'debug']).default('info'),
    /** "json" for log shipping (default in production), "pretty" for a terminal. */
    LOG_FORMAT: optional(z.enum(['json', 'pretty'])),
    /** Error reporting. No DSN = Sentry is not even loaded. */
    SENTRY_DSN: optional(z.url()),
    SENTRY_ENVIRONMENT: optional(z.string().min(1)),
    SENTRY_TRACES_SAMPLE_RATE: z.coerce.number().min(0).max(1).default(0),
    /** On SIGTERM: report "draining" on /health/ready for this long before closing, so the load balancer stops first. */
    SHUTDOWN_DRAIN_MS: z.coerce.number().int().min(0).max(60_000).default(0),
    /** Hard stop: if graceful shutdown takes longer than this, exit anyway. */
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120_000).default(25_000),
    /** Where critical alerts are posted (Slack-style incoming webhook). Unset = alerts only reach the log and Sentry. */
    ALERT_WEBHOOK_URL: optional(z.url()),
    /** Nightly ledger_check_invariants job (02:15 Africa/Lagos). Keep on everywhere except throwaway environments. */
    LEDGER_CHECK_ENABLED: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** On a wallet mismatch, freeze Pool for the affected users until a human clears it (ledger_check_invariants(true)). */
    LEDGER_CHECK_FREEZE: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
    /** Pinged (GET) after every CLEAN nightly run; a dead-man's-switch monitor alerts when the pings stop. */
    LEDGER_CHECK_HEARTBEAT_URL: optional(z.url()),
  })
  .superRefine((env, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });

    if (env.NODE_ENV === 'production') {
      if (env.OTP_TEST_CODE) fail('OTP_TEST_CODE', 'must not be set in production');
      if (env.SMS_DRIVER !== 'real') fail('SMS_DRIVER', 'must be "real" in production');
      if (env.PUSH_DRIVER !== 'expo') fail('PUSH_DRIVER', 'must be "expo" in production');
      if (env.INTEGRITY_DRIVER !== 'store') {
        fail(
          'INTEGRITY_DRIVER',
          'must be "store" in production (the "dev" driver passes every device)',
        );
      }
    }
    for (const problem of parseReviewLogins(env.REVIEW_LOGINS).errors)
      fail('REVIEW_LOGINS', problem);
    if (env.ADMIN_TOKENS && !env.ADMIN_DATABASE_URL) {
      fail(
        'ADMIN_DATABASE_URL',
        'is required when ADMIN_TOKENS is set (the moderation API has its own database role)',
      );
    }
    if (env.NODE_ENV === 'production' && env.EMAIL_AUTH_ENABLED && env.EMAIL_DRIVER !== 'resend') {
      fail(
        'EMAIL_DRIVER',
        'must be "resend" in production while EMAIL_AUTH_ENABLED is true (the console driver prints codes to the log); set EMAIL_AUTH_ENABLED=false to run without email sign-in',
      );
    }
    if (env.EMAIL_DRIVER === 'resend') {
      if (!env.RESEND_API_KEY) fail('RESEND_API_KEY', 'is required when EMAIL_DRIVER is "resend"');
      if (!env.EMAIL_FROM || !isSenderAddress(env.EMAIL_FROM)) {
        fail(
          'EMAIL_FROM',
          'is required for Resend, as `Name <address@your-domain>` or a bare address',
        );
      }
    }
    if (env.SMS_DRIVER === 'real' && !hasTermii(env) && !hasTwilio(env)) {
      fail(
        'SMS_DRIVER',
        'real SMS needs Termii (key + sender id) or Twilio (sid + token + from/messaging service)',
      );
    }
  });

export type Env = z.infer<typeof envSchema>;

/** `Dyce <login@mail.dyce.games>` or `login@mail.dyce.games`. */
export function isSenderAddress(value: string): boolean {
  const v = value.trim();
  const bare = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;
  const named = /^[^<>@\r\n]{1,100}<[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+>$/;
  return bare.test(v) || named.test(v);
}

export function hasTermii(env: Pick<Env, 'TERMII_API_KEY' | 'TERMII_SENDER_ID'>): boolean {
  return Boolean(env.TERMII_API_KEY && env.TERMII_SENDER_ID);
}

export function hasTwilio(
  env: Pick<
    Env,
    'TWILIO_ACCOUNT_SID' | 'TWILIO_AUTH_TOKEN' | 'TWILIO_FROM' | 'TWILIO_MESSAGING_SERVICE_SID'
  >,
): boolean {
  return Boolean(
    env.TWILIO_ACCOUNT_SID &&
    env.TWILIO_AUTH_TOKEN &&
    (env.TWILIO_FROM || env.TWILIO_MESSAGING_SERVICE_SID),
  );
}

export function validateEnv(raw: Record<string, unknown>): Env {
  const parsed = envSchema.safeParse(raw);
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid environment: ${problems}`);
  }
  return parsed.data;
}
