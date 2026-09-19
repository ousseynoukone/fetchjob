import { Controller, Post } from '@nestjs/common';
import { SessionHealthService } from './session-health.service';

// Manual "check now" trigger — the same full refresh pass the cron already
// runs every 30 minutes, fired on demand instead of waiting for the next
// tick (e.g. right after logging in somewhere, or to answer "is everything
// still connected" without digging through logs).
@Controller('parametres/session-health')
export class SessionHealthController {
  constructor(private sessionHealth: SessionHealthService) {}

  @Post('check-now')
  async checkNow() {
    return this.sessionHealth.run();
  }
}
