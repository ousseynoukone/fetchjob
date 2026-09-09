import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { PlatformCredentialsService } from './platform-credentials.service';
import { UpsertCredentialDto, SupportedPlatform } from './dto/upsert-credential.dto';

@Controller('parametres/identifiants')
export class PlatformCredentialsController {
  constructor(private credentials: PlatformCredentialsService) {}

  @Get()
  async list() {
    return this.credentials.listStatus();
  }

  @Put()
  async upsert(@Body() dto: UpsertCredentialDto) {
    return this.credentials.upsert(dto.platform, dto.email, dto.password);
  }

  @Delete(':platform')
  async remove(@Param('platform') platform: SupportedPlatform) {
    return this.credentials.remove(platform);
  }
}
