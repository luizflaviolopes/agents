/**
 * Minimal async counting semaphore with FIFO waiters.
 *
 * Shared between the task poller (acquires a slot per claimed task) and the
 * task executor (the ask_agent tool RELEASES its slot while it waits for a
 * child task and re-acquires it before resuming — otherwise two parent tasks
 * waiting on children would deadlock a fully-occupied pool).
 *
 * release() hands the permit straight to the oldest waiter when one exists,
 * so parents waiting to resume take priority over the poller claiming new
 * work (the poller only uses tryAcquire()).
 */
export class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  /** Number of currently free permits (waiters pending count as demand). */
  get available(): number {
    return this.permits;
  }

  /** Non-blocking acquire. Returns true when a permit was taken. */
  tryAcquire(): boolean {
    if (this.permits > 0) {
      this.permits -= 1;
      return true;
    }
    return false;
  }

  /** Waits until a permit is available, then takes it. */
  async acquire(): Promise<void> {
    if (this.tryAcquire()) return;
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Returns a permit; the oldest waiter (if any) receives it immediately. */
  release(): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      // Permit is transferred directly to the waiter; count stays the same.
      waiter();
    } else {
      this.permits += 1;
    }
  }
}
