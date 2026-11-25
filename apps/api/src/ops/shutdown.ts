import { Injectable, type BeforeApplicationShutdown } from '@nestjs/common';

/**
 * Graceful shutdown, step one. On SIGTERM Nest runs `beforeApplicationShutdown` while the HTTP server still
 * accepts connections: we flip readiness to "draining" (the load balancer stops sending new traffic after its next
 * probe), wait `SHUTDOWN_DRAIN_MS`, and only then let Nest close the server, the WebSocket hub and the pool.
 */
@Injectable()
export class ShutdownState implements BeforeApplicationShutdown {
  private drainingSince: number | null = null;

  constructor(private readonly drainMs: number = 0) {}

  get draining(): boolean {
    return this.drainingSince !== null;
  }

  async beforeApplicationShutdown(): Promise<void> {
    this.drainingSince = Date.now();
    if (this.drainMs > 0) await new Promise((resolve) => setTimeout(resolve, this.drainMs));
  }
}
