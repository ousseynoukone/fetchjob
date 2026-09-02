import { Module } from '@nestjs/common';
import { ScrapingService } from './scraping.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  providers: [ScrapingService],
  exports: [ScrapingService],
})
export class ScrapingModule {}
