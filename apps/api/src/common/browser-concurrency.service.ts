import { Injectable, Logger } from '@nestjs/common';

/**
 * App-wide serialization for CPU-heavy browser-automation work (scraping,
 * session-health refreshes, platform-status checks, Gmail OTP retrieval,
 * campaign applying).
 *
 * Confirmed live: these are scheduled independently — session-health every
 * 20min, platform-status/response-tracker/campaigns on hourly wake-ups —
 * with no cross-service coordination (each only guards against a SECOND
 * copy of ITSELF overlapping, not against each other). They're free to run
 * at the same time, each driving a browser and doing heavy synchronous JS
 * (page evaluation, HTML parsing, job-card enrichment) on the one Node.js
 * thread the whole API runs on. That's confirmed to be what pegged the API
 * process at ~99% CPU for 4+ hours straight and made it unable to answer
 * ordinary requests (see incident write-up — pid 41594).
 *
 * This doesn't make any single task faster; it stops them from stacking on
 * top of each other, which is what turned "briefly busy" into "frozen for
 * hours". Everything routed through here runs one at a time, in the order
 * it arrived.
 */
@Injectable()
export class BrowserConcurrencyService {
  private readonly logger = new Logger(BrowserConcurrencyService.name);
  private mutex: Promise<unknown> = Promise.resolve();
  private queueDepth = 0;

  async runExclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.queueDepth++;
    if (this.queueDepth > 1) {
      this.logger.log(`[${label}] waiting — ${this.queueDepth - 1} other browser task(s) ahead of it...`);
    }
    const waitForTurn = this.mutex;
    const run = waitForTurn.then(() => fn());
    // Swallow the outcome here so one task's failure never poisons the
    // chain for whoever queues up next.
    this.mutex = run.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await run;
    } finally {
      this.queueDepth--;
    }
  }
}
