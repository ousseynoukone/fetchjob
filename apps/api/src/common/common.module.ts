import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { LocalUserService } from './local-user.service';
import { SettingsService } from './settings.service';
import { CryptoService } from './crypto.service';

@Module({
  providers: [PrismaService, LocalUserService, SettingsService, CryptoService],
  exports: [PrismaService, LocalUserService, SettingsService, CryptoService],
})
export class CommonModule {}
