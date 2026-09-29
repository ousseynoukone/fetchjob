import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { LocalUserService } from './local-user.service';
import { SettingsService } from './settings.service';
import { CryptoService } from './crypto.service';
import { GmailOtpService } from './gmail-otp.service';
import { BrowserConcurrencyService } from './browser-concurrency.service';

@Module({
  providers: [PrismaService, LocalUserService, SettingsService, CryptoService, GmailOtpService, BrowserConcurrencyService],
  exports: [PrismaService, LocalUserService, SettingsService, CryptoService, GmailOtpService, BrowserConcurrencyService],
})
export class CommonModule {}
