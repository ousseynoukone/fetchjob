import { Module } from '@nestjs/common';
import { ApplicationPrepService } from './application-prep.service';
import { CommonModule } from '../common/common.module';
import { AiModule } from '../ai/ai.module';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [CommonModule, AiModule, GithubModule],
  providers: [ApplicationPrepService],
  exports: [ApplicationPrepService],
})
export class ApplicationPrepModule {}
