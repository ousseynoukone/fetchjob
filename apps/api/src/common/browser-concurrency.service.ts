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
 *
 * Confirmed live, the same day this was added: a single applyToOne attempt
 * got wedged (Indeed, ~3h with no log output but nonzero CPU -- a
 * synchronous hang, not an I/O wait, since applyToOne's own 150s+5s
 * watchdog is a setTimeout and a truly synchronous block prevents even
 * that from ever firing). Before this lock existed, a wedged attempt only
 * blocked its OWN campaign loop. With a plain unconditional queue, it
 * blocked session-health, scraping and every other campaign too -- for as
 * long as it stayed stuck, unbounded. MAX_WAIT_MS below is the fix: a
 * queued caller gives up waiting after a generous grace period and runs
 * anyway rather than waiting forever. That reintroduces the exact
 * CPU-contention this class exists to prevent, but only as a last resort
 * after a long wait -- guaranteed forward progress beats a guaranteed
 * permanent freeze.
 */
@Injectable()
export class BrowserConcurrencyService {
  private readonly logger = new Logger(BrowserConcurrencyService.name);
  private mutex: Promise<unknown> = Promise.resolve();
  private queueDepth = 0;

  // Generous relative to any single legitimate task: applyToOne's own
  // internal watchdog bounds it to ~155s; a scrape/session-health cycle is
  // normally well under a minute. 5 minutes gives real contention plenty
  // of room while still capping how long anything can be blocked by a
  // task that's actually stuck.
  private static readonly MAX_WAIT_MS = 5 * 60 * 1000;

  async runExclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    this.queueDepth++;
    if (this.queueDepth > 1) {
      this.logger.log(`[${label}] waiting — ${this.queueDepth - 1} other browser task(s) ahead of it...`);
    }
    const waitForTurn = this.mutex;

    const run = (async () => {
      const gotTurn = await Promise.race([
        waitForTurn.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), BrowserConcurrencyService.MAX_WAIT_MS)),
      ]);
      if (!gotTurn) {
        this.logger.error(
          `[${label}] waited over ${BrowserConcurrencyService.MAX_WAIT_MS / 1000}s for the browser lock — ` +
            `whatever's ahead of it appears stuck. Proceeding anyway instead of waiting forever.`,
        );
      }
      return fn();
    })();

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
