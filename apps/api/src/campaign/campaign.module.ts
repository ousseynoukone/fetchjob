import { Module } from '@nestjs/common';
import { CampaignService } from './campaign.service';
import { CampaignController } from './campaign.controller';
import { CommonModule } from '../common/common.module';
import { CvModule } from '../cv/cv.module';
import { ScrapingModule } from '../scraping/scraping.module';
import { MatchingModule } from '../matching/matching.module';
import { ApplicationPrepModule } from '../applications/application-prep.module';

@Module({
  imports: [CommonModule, CvModule, ScrapingModule, MatchingModule, ApplicationPrepModule],
  providers: [CampaignService],
  controllers: [CampaignController],
  exports: [CampaignService],
})
export class CampaignModule {}
