import { Injectable, Logger, OnModuleInit } from '@nestjs/common';

// Confirmed live: the API sat for ~3h logging nothing while still burning
// CPU, and by the time it was noticed there was nothing left to diagnose
// -- the process had already been killed. A synchronous block prevents
// setInterval from firing on schedule the same way it prevents any other
// timer (including BrowserConcurrencyService's own watchdog) from firing,
// so a large, sustained gap between expected and actual tick time IS the
// symptom, cheaply, without needing a profiler already attached. This
// exists purely to leave a timestamped trail the next time it happens,
// not to fix anything itself.
@Injectable()
export class EventLoopMonitorService implements OnModuleInit {
  private readonly logger = new Logger(EventLoopMonitorService.name);
  private static readonly TICK_MS = 5_000;
  private static readonly WARN_LAG_MS = 3_000;

  onModuleInit() {
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      const lag = now - last - EventLoopMonitorService.TICK_MS;
      last = now;
      if (lag > EventLoopMonitorService.WARN_LAG_MS) {
        this.logger.warn(`Event loop lagged ${Math.round(lag / 1000)}s behind schedule — something blocked it synchronously.`);
      }
    }, EventLoopMonitorService.TICK_MS);
  }
}
