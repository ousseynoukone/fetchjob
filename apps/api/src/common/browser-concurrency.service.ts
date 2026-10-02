import { Injectable, Logger } from '@nestjs/common';

/**
 * Caps how much CPU-heavy browser-automation work (scraping, session-health
 * refreshes, platform-status checks, Gmail OTP retrieval, campaign applying)
 * runs at once, instead of letting all of it — scheduled completely
 * independently (session-health every 20min, platform-status/response-
 * tracker/campaigns on hourly wake-ups, each only guarding against a SECOND
 * copy of ITSELF, never against the others) — pile up simultaneously and peg
 * the one Node.js thread the whole API runs on (confirmed live: ~99% CPU for
 * 4+ hours straight, API unable to answer ordinary requests — pid 41594).
 *
 * MAX_CONCURRENT, not a hard 1-at-a-time mutex: Chrome/Playwright fully
 * supports several BrowserContexts running at once in the SAME browser —
 * that's a normal, supported pattern, not something that needed serializing
 * away. A hard mutex over-corrected for the CPU-contention problem above and
 * instead forced completely unrelated work to ping-pong the lock for hours:
 * confirmed live, a single WTTJ job-description fetch and an unrelated
 * platform's session-health check traded it back and forth 60+ times across
 * one campaign run, stretching it from under an hour to 4+ hours with
 * nothing actually stuck. This keeps the original protection (a bounded
 * number of heavy tasks at once, not unlimited) while letting genuinely
 * independent work actually run in parallel.
 */
@Injectable()
export class BrowserConcurrencyService {
  private readonly logger = new Logger(BrowserConcurrencyService.name);

  // Confirmed live: 3 was too low for how much real concurrent demand this
  // app generates on its own — 7 platforms' session-health (every ~20min)
  // plus continuous per-offer enrichment during a campaign arrive faster
  // than 3 slots can drain. The queue grew without bound (5 -> 11 queued
  // over 17 minutes) and the 5-minute timeout-bypass below stopped being a
  // rare safety valve and became the NORMAL path for most tasks -- every
  // queued task waiting the full 5 minutes before even starting is exactly
  // why a campaign looked frozen rather than just busy. Raised to actually
  // match the real workload instead of fighting it.
  private static readonly MAX_CONCURRENT = 8;

  // Generous relative to any single legitimate task: applyToOne's own
  // internal watchdog bounds it to ~155s; a scrape/session-health cycle is
  // normally well under a minute. Lowered from 5 min now that MAX_CONCURRENT
  // is high enough that hitting this at all should be rare -- if something
  // still waits this long, it's much more likely to actually be stuck than
  // just caught behind ordinary contention, so there's less reason to make
  // everyone else wait the full 5 minutes to find out.
  private static readonly MAX_WAIT_MS = 2 * 60 * 1000;

  private activeCount = 0;
  private readonly waiters: Array<() => void> = [];

  async runExclusive<T>(label: string, fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= BrowserConcurrencyService.MAX_CONCURRENT) {
      this.logger.log(
        `[${label}] waiting — ${BrowserConcurrencyService.MAX_CONCURRENT} browser task(s) already running, ` +
          `${this.waiters.length + 1} queued ahead of/with it...`,
      );
    }

    let timedOut = false;
    // Set when a queued slot is handed to us AFTER we've already given up
    // and run unmanaged below — we pass it straight to whoever's next
    // instead of leaking it or double-running fn().
    let handedOffUnused = false;

    const acquire = (): Promise<void> => {
      if (this.activeCount < BrowserConcurrencyService.MAX_CONCURRENT) {
        this.activeCount++;
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        this.waiters.push(() => {
          if (timedOut) {
            handedOffUnused = true;
            this.release();
            return;
          }
          this.activeCount++;
          resolve();
        });
      });
    };

    const acquired = await Promise.race([
      acquire().then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), BrowserConcurrencyService.MAX_WAIT_MS)),
    ]);

    if (!acquired) {
      timedOut = true;
      this.logger.error(
        `[${label}] waited over ${BrowserConcurrencyService.MAX_WAIT_MS / 1000}s for a browser slot — ` +
          `proceeding anyway instead of waiting forever.`,
      );
      return fn();
    }

    try {
      return await fn();
    } finally {
      if (!handedOffUnused) this.release();
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand the slot straight to the next waiter — activeCount is
      // unchanged, ownership just transfers.
      next();
    } else {
      this.activeCount--;
    }
  }
}
