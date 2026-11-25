/**
 * Keeps phone numbers, tokens and secrets out of logs, error reports and alerts (CLAUDE.md privacy rule).
 * Pure and dependency-free, so the API, the game server and the app all use this one copy. If you change a
 * pattern, run the tests in apps/api/src/ops/redact.test.ts: they are the contract.
 *
 * Two layers: values of sensitive KEYS are replaced wholesale, and free text is scrubbed for anything
 * that LOOKS like a phone number or a credential. Over-redaction is the safe failure mode.
 */
export const REDACTED = '[redacted]';

/** Object keys whose values are never logged. `code` is deliberately absent: error codes are useful. */
const SENSITIVE_KEY =
  /(token|secret|password|passwd|authorization|cookie|otp|phone|e-?mail|msisdn|mobile|api[-_]?key|apikey|salt|dsn|signature|credential|contacts?_?hash|jwt)/i;

const PATTERNS: readonly [RegExp, string][] = [
  // JWTs (three base64url parts, the first two start like JSON).
  [/\beyJ[\w-]{6,}\.[\w-]{6,}\.[\w-]*/g, REDACTED],
  [/\bBearer\s+[\w.~+/=-]{8,}/gi, `Bearer ${REDACTED}`],
  // Credentials in URLs: scheme://user:password@host
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],
  // key=value / key: value pairs for sensitive keys inside free text.
  [
    /\b((?:access|refresh|api|auth|secret|session|invite)[-_]?(?:token|key|secret)|password|otp|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;&]+/gi,
    `$1$2${REDACTED}`,
  ],
  // Query-string values for sensitive parameters: ?token=..., &phone=..., &sig=...
  [
    /([?&](?:[\w-]*(?:token|key|secret|otp|code|phone|password|sig|signature)[\w-]*)=)[^\s&"']+/gi,
    `$1${REDACTED}`,
  ],
  // Email addresses anywhere in free text.
  [/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi, REDACTED],
  // E.164 and formatted international numbers: +234 803 123 4567, +2348031234567, +1 (415) 555-0100.
  [/\+\d[\d\s().-]{6,17}\d/g, REDACTED],
  // Nigerian numbers without the plus: 2348031234567 and 08031234567.
  [/\b234[789]\d{9}\b/g, REDACTED],
  [/\b0[789][01]\d{8}\b/g, REDACTED],
];

export function redactString(input: string): string {
  let out = input;
  for (const [re, replacement] of PATTERNS) out = out.replace(re, replacement);
  return out;
}

const MAX_DEPTH = 6;

/** Deep copy with sensitive keys blanked and strings scrubbed. Never throws; cycles become "[circular]". */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return '[circular]';
  if (depth >= MAX_DEPTH) return '[truncated]';
  seen.add(value);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message),
      ...(value.stack ? { stack: redactString(value.stack) } : {}),
    };
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactValue(v, depth + 1, seen);
  }
  return out;
}
