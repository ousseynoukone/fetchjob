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

  @Put()
  async update(@Body() dto: UpdateSettingsDto) {
    return this.settings.update(dto);
  }
}
