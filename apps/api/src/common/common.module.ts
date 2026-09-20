import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { LocalUserService } from './local-user.service';
import { SettingsService } from './settings.service';
import { CryptoService } from './crypto.service';
import { GmailOtpService } from './gmail-otp.service';

@Module({
  providers: [PrismaService, LocalUserService, SettingsService, CryptoService, GmailOtpService],
  exports: [PrismaService, LocalUserService, SettingsService, CryptoService, GmailOtpService],
})
export class CommonModule {}
