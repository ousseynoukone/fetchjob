import { Module } from '@nestjs/common';
import { PrismaService } from './prisma.service';
import { LocalUserService } from './local-user.service';
import { SettingsService } from './settings.service';
import { CryptoService } from './crypto.service';
import { GmailOtpService } from './gmail-otp.service';
import { BrowserConcurrencyService } from './browser-concurrency.service';
import { EventLoopMonitorService } from './event-loop-monitor.service';

@Module({
  providers: [PrismaService, LocalUserService, SettingsService, CryptoService, GmailOtpService, BrowserConcurrencyService, EventLoopMonitorService],
  exports: [PrismaService, LocalUserService, SettingsService, CryptoService, GmailOtpService, BrowserConcurrencyService],
})
export class CommonModule {}
