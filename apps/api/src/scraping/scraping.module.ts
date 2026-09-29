import { Module } from '@nestjs/common';
import { ScrapingService } from './scraping.service';
import { CommonModule } from '../common/common.module';
import { PlatformCredentialsModule } from '../platform-credentials/platform-credentials.module';

@Module({
  imports: [CommonModule, PlatformCredentialsModule],
  providers: [ScrapingService],
  exports: [ScrapingService],
})
export class ScrapingModule {}
