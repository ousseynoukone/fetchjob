import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GithubService } from '../github/github.service';
import { KnowledgeService } from './knowledge.service';
import { LocalUserService } from '../common/local-user.service';

@Injectable()
export class GithubSyncService {
  private readonly logger = new Logger(GithubSyncService.name);

  constructor(
    private github: GithubService,
    private knowledge: KnowledgeService,
    private localUser: LocalUserService,
  ) {}

  // Daily automatic refresh, in addition to the manual "Synchroniser
  // maintenant" button — keeps the knowledge base current with new commits/
  // repos without requiring the user to remember to re-sync.
  @Cron('0 4 * * *')
  async scheduledSync() {
    try {
      await this.syncForDefaultUser();
    } catch (error: any) {
      this.logger.warn(`Scheduled GitHub sync failed: ${error.message}`);
    }
  }

  async syncForDefaultUser(): Promise<{ synced: number }> {
    const userId = await this.localUser.getDefaultUserId();
    const token = await this.knowledge.getDecryptedGithubToken(userId);
    if (!token) {
      return { synced: 0 };
    }

    const repos = await this.github.listAllRepos(token);

    // Sequential rather than Promise.all: keeps Neon's pooled connection
    // usage bounded, and a personal GitHub account's repo count is small
    // enough that the extra latency doesn't matter.
    for (const repo of repos) {
      await this.knowledge.upsertItem(userId, {
        source: 'github',
        type: 'repo',
        externalId: repo.externalId,
        title: repo.name,
        summary: [repo.description, repo.readmeExcerpt].filter(Boolean).join(' — '),
        skills: [repo.language, ...repo.topics].filter((v): v is string => !!v),
        url: repo.url,
        metadata: { stars: repo.stars, private: repo.private, pushedAt: repo.pushedAt },
      });
    }

    this.logger.log(`GitHub sync: ${repos.length} repo(s) upserted into knowledge base`);
    return { synced: repos.length };
  }
}
