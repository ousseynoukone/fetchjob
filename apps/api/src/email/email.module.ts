import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { DigestService } from './digest.service';
import { ApplicationResponseTrackerService } from './response-tracker.service';
import { CommonModule } from '../common/common.module';
import { AiModule } from '../ai/ai.module';

@Module({
  imports: [CommonModule, AiModule],
  providers: [EmailService, DigestService, ApplicationResponseTrackerService],
  exports: [EmailService],
})
export class EmailModule {}
