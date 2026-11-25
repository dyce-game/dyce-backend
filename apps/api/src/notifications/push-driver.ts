/**
 * Push delivery sits behind this small interface (ADR-023): `console` in development, the Expo Push API in
 * production. The dispatcher decides *whether* and *what* to send; a driver only moves bytes.
 */
export type PushMessage = {
  /** An Expo push token (ExponentPushToken[...]). */
  to: string;
  title: string;
  body: string;
  /** Delivered to the app with the notification; the tap handler routes on `route`. */
  data: Record<string, unknown>;
  /** The app icon badge number (unread notifications). */
  badge?: number;
};

export type PushResult =
  | { ok: true }
  | {
      ok: false;
      /** A short reason for logs, never message content. */
      error: string;
      /** The token is dead (app uninstalled, token revoked): stop using it. */
      invalidToken: boolean;
      /** Worth trying again later (network trouble, the service asked us to slow down). */
      retry: boolean;
    };

export interface PushDriver {
  /** One result per message, in the same order. Throws only if nothing could be attempted. */
  send(messages: PushMessage[]): Promise<PushResult[]>;
}

/** Tokens are secrets of a sort (anyone holding one can push to the device): never log more than a stub. */
export function maskToken(token: string): string {
  const open = token.indexOf('[');
  return open < 0 ? `…${token.slice(-4)}` : `${token.slice(0, open + 1)}…${token.slice(-5, -1)}]`;
}
