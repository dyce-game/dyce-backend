import type { Env } from '../config/env.ts';
import { ConsoleEmailProvider, ResendEmailProvider, type EmailProvider } from './email-provider.ts';

/** Builds the email provider from validated config. Env validation already guarantees a safe combination. */
export function buildEmailProvider(env: Env): EmailProvider {
  if (env.EMAIL_DRIVER === 'console') return new ConsoleEmailProvider();
  return new ResendEmailProvider({
    apiKey: env.RESEND_API_KEY!,
    from: env.EMAIL_FROM!,
    replyTo: env.EMAIL_REPLY_TO,
    baseUrl: env.RESEND_BASE_URL,
  });
}
