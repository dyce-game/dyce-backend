import { maskToken, type PushDriver, type PushMessage, type PushResult } from './push-driver.ts';

/** Development driver: prints what would be pushed (token masked) and keeps the last messages for tests. */
export class ConsolePushDriver implements PushDriver {
  readonly sent: PushMessage[] = [];

  constructor(private readonly log: (line: string) => void = (l) => console.log(l)) {}

  send(messages: PushMessage[]): Promise<PushResult[]> {
    for (const m of messages) {
      this.sent.push(m);
      if (this.sent.length > 200) this.sent.shift();
      this.log(`[push] ${maskToken(m.to)} "${m.title}": ${m.body}`);
    }
    return Promise.resolve(messages.map((): PushResult => ({ ok: true })));
  }
}
