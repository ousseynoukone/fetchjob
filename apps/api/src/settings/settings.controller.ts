import { Controller, Get, Put, Body } from '@nestjs/common';
import { SettingsService } from '../common/settings.service';
import { UpdateSettingsDto } from './dto/update-settings.dto';

@Controller('parametres')
export class SettingsController {
  constructor(private settings: SettingsService) {}

  @Get()
  async status() {
    return this.settings.status();
  }

  // Registered before any future ':id'-shaped route for the same reason
  // already documented in applications.controller.ts.
  @Get('missing-config-count')
  async missingConfigCount() {
    return { count: await this.settings.getMissingConfigCount() };
  }

  @Put()
  async update(@Body() dto: UpdateSettingsDto) {
    return this.settings.update(dto);
  }
}
