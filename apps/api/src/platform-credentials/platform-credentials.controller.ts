import { Controller, Delete, Get, Param } from '@nestjs/common';
import { PlatformCredentialsService } from './platform-credentials.service';
import { SupportedPlatform } from './dto/upsert-credential.dto';

// Sessions are established out-of-band by the user, via
// `npm run establish-session -- <platform> <email>` on their own machine
// (see scripts/establish-session.js) — there is no form here to submit
// credentials through.
@Controller('parametres/identifiants')
export class PlatformCredentialsController {
  constructor(private credentials: PlatformCredentialsService) {}

  @Get()
  async list() {
    return this.credentials.listStatus();
  }

  @Delete(':platform')
  async remove(@Param('platform') platform: SupportedPlatform) {
    return this.credentials.remove(platform);
  }
}
