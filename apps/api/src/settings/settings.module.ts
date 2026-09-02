import { Module } from '@nestjs/common';
import { SettingsController } from './settings.controller';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [SettingsController],
})
export class SettingsModule {}
