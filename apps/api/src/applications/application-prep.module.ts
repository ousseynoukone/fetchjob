import { Module } from '@nestjs/common';
import { ApplicationPrepService } from './application-prep.service';
import { CommonModule } from '../common/common.module';
import { AiModule } from '../ai/ai.module';
import { KnowledgeModule } from '../knowledge/knowledge.module';

@Module({
  imports: [CommonModule, AiModule, KnowledgeModule],
  providers: [ApplicationPrepService],
  exports: [ApplicationPrepService],
})
export class ApplicationPrepModule {}
