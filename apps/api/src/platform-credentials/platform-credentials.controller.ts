import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';
import { PlatformCredentialsService } from './platform-credentials.service';
import { SupportedPlatform, UpsertCredentialDto } from './dto/upsert-credential.dto';

@Controller('parametres/identifiants')
export class PlatformCredentialsController {
  constructor(private credentials: PlatformCredentialsService) {}

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
}
