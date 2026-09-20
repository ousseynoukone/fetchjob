import { Body, Controller, Delete, Get, Param, Post, Sse, MessageEvent } from '@nestjs/common';
import { map, catchError, of } from 'rxjs';
import { PlatformCredentialsService } from './platform-credentials.service';
import { RemoteLoginService } from './remote-login.service';
import { SupportedPlatform, UpsertCredentialDto } from './dto/upsert-credential.dto';

@Controller('parametres/identifiants')
export class PlatformCredentialsController {
  constructor(
    private credentials: PlatformCredentialsService,
    private remoteLogin: RemoteLoginService,
  ) {}

  @Get()
  async list() {
    return this.credentials.listStatus();
  }

  @Post()
  async upsert(@Body() dto: UpsertCredentialDto) {
    return this.credentials.upsert(dto);
  }

  @Delete(':platform')
  async remove(@Param('platform') platform: SupportedPlatform) {
    return this.credentials.remove(platform);
  }

  // Starts a real, server-driven browser navigated to the platform's own
  // login page — the frontend then watches it live (see the SSE endpoint
  // below) and relays the person's own clicks/typing into it, so THEY log
  // in exactly as they would in their own browser (solving any CAPTCHA/2FA
  // themselves), instead of this app ever touching a password.
  @Post(':platform/remote-login/start')
  async startRemoteLogin(
    @Param('platform') platform: SupportedPlatform,
    @Body('targetUrl') targetUrl?: string
  ) {
    const sessionId = await this.remoteLogin.start(platform, targetUrl);
    return { sessionId };
  }

  @Sse(':platform/remote-login/:sessionId/stream')
  streamRemoteLogin(@Param('sessionId') sessionId: string): import('rxjs').Observable<MessageEvent> {
    return this.remoteLogin.getFrames(sessionId).pipe(
      map((frame) => ({ data: frame }) as MessageEvent),
      catchError((error) => of({ data: { dataUrl: null, status: 'error', message: error.message } } as MessageEvent)),
    );
  }

  @Post(':platform/remote-login/:sessionId/input')
  async sendRemoteLoginInput(@Param('sessionId') sessionId: string, @Body() event: any) {
    await this.remoteLogin.input(sessionId, event);
    return { ok: true };
  }

  @Post(':platform/remote-login/:sessionId/stop')
  async stopRemoteLogin(@Param('sessionId') sessionId: string) {
    await this.remoteLogin.stop(sessionId);
    return { ok: true };
  }

  // Only meaningful for MANUAL_CONFIRM_PLATFORMS (gmail) — the "J'ai
  // terminé" button once the person has actually finished logging in
  // themselves, since that flow never auto-polls for completion the way
  // every other platform's does.
  @Post(':platform/remote-login/:sessionId/confirm')
  async confirmRemoteLogin(@Param('sessionId') sessionId: string) {
    return this.remoteLogin.confirmManualLogin(sessionId);
  }
}
