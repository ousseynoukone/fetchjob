import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { LocalUserService } from './local-user.service';
import { SettingsService } from './settings.service';

@Module({
  providers: [PrismaService, LocalUserService, SettingsService],
  exports: [PrismaService, LocalUserService, SettingsService],
})
export class CommonModule {}
