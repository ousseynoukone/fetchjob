import { Body, Controller, Delete, Get, Post, Put } from '@nestjs/common';
import { KnowledgeService } from './knowledge.service';
import { GithubSyncService } from './github-sync.service';
import { SaveGithubTokenDto } from './dto/save-github-token.dto';

@Controller('knowledge')
export class KnowledgeController {
  constructor(
    private knowledge: KnowledgeService,
    private githubSync: GithubSyncService,
  ) {}

  @Get()
  async list() {
    return this.knowledge.listItems();
  }

  @Get('status')
  async status() {
    return this.knowledge.getStatus();
  }

  @Put('github-token')
  async saveGithubToken(@Body() dto: SaveGithubTokenDto) {
    return this.knowledge.saveGithubToken(dto.token, dto.username);
  }

  @Delete('github-token')
  async removeGithubToken() {
    return this.knowledge.removeGithubToken();
  }

  @Post('sync')
  async sync() {
    return this.githubSync.syncForDefaultUser();
  }
}
