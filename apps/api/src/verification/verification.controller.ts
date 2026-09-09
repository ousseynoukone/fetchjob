import { Controller, Get, Post, Sse, MessageEvent } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { VerificationService } from './verification.service';

@Controller('verification')
export class VerificationController {
  constructor(private verificationService: VerificationService) {}

  @Post('run')
  async runVerification() {
    return this.verificationService.run();
  }

  @Get('latest')
  async getLatest() {
    return this.verificationService.getLatestRun();
  }

  @Get('runs')
  async getRuns() {
    return this.verificationService.getRunHistory();
  }

  @Sse('stream')
  streamLogs(): Observable<MessageEvent> {
    return this.verificationService.streamLogs().pipe(map((event) => ({ data: event })));
  }
}
