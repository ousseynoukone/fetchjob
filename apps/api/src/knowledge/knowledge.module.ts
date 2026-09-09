import { Module } from '@nestjs/common';
import { KnowledgeController } from './knowledge.controller';
import { KnowledgeService } from './knowledge.service';
import { GithubSyncService } from './github-sync.service';
import { CommonModule } from '../common/common.module';
import { GithubModule } from '../github/github.module';

@Module({
  imports: [CommonModule, GithubModule],
  controllers: [KnowledgeController],
  providers: [KnowledgeService, GithubSyncService],
  exports: [KnowledgeService, GithubSyncService],
})
export class KnowledgeModule {}
