import { Module } from '@nestjs/common';
import { ApplicationsService } from './applications.service';
import { ApplicationsController } from './applications.controller';
import { CommonModule } from '../common/common.module';
import { CvModule } from '../cv/cv.module';
import { MatchingModule } from '../matching/matching.module';
import { CampaignModule } from '../campaign/campaign.module';
import { ApplicationPrepModule } from './application-prep.module';
import { PdfModule } from '../pdf/pdf.module';

@Module({
  imports: [CommonModule, CvModule, MatchingModule, CampaignModule, ApplicationPrepModule, PdfModule],
  providers: [ApplicationsService],
  controllers: [ApplicationsController],
})
export class ApplicationsModule {}
