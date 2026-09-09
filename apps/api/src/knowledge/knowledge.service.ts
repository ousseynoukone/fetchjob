import { Injectable } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { LocalUserService } from '../common/local-user.service';
import type { KnowledgeItem } from '@prisma/client';

const GITHUB_PLATFORM = 'github';
const DIACRITICS_REGEX = new RegExp('[\\u0300-\\u036f]', 'g');

function normalize(text: string): string {
  return (text || '').toLowerCase().normalize('NFD').replace(DIACRITICS_REGEX, '');
}

// Same word-overlap idea as MatchingService, applied here to rank knowledge
// items against an offer instead of ranking offers against a CV.
function wordOverlapCount(haystackNorm: string, needle: string): number {
  const words = new Set(normalize(needle).match(/[a-z0-9+#.]{3,}/g) || []);
  let count = 0;
  for (const word of words) if (haystackNorm.includes(word)) count++;
  return count;
}

export interface RelevantContext {
  text: string;
  items: KnowledgeItem[];
}

@Injectable()
export class KnowledgeService {
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private localUser: LocalUserService,
  ) {}

  async listItems() {
    const userId = await this.localUser.getDefaultUserId();
    return this.prisma.knowledgeItem.findMany({
      where: { userId },
      orderBy: { syncedAt: 'desc' },
    });
  }

  async getStatus() {
    const userId = await this.localUser.getDefaultUserId();
    const [githubAccount, itemCount, lastItem] = await Promise.all([
      this.prisma.linkedAccount.findUnique({ where: { userId_platform: { userId, platform: GITHUB_PLATFORM } } }),
      this.prisma.knowledgeItem.count({ where: { userId } }),
      this.prisma.knowledgeItem.findFirst({ where: { userId }, orderBy: { syncedAt: 'desc' } }),
    ]);

    return {
      githubConfigured: !!githubAccount,
      githubUsername: githubAccount?.platformEmail || null,
      itemCount,
      lastSyncedAt: lastItem?.syncedAt || null,
    };
  }

  async saveGithubToken(token: string, username?: string) {
    const userId = await this.localUser.getDefaultUserId();
    await this.prisma.linkedAccount.upsert({
      where: { userId_platform: { userId, platform: GITHUB_PLATFORM } },
      update: { accessToken: this.crypto.encrypt(token), platformEmail: username || undefined },
      create: { userId, platform: GITHUB_PLATFORM, accessToken: this.crypto.encrypt(token), platformEmail: username },
    });
    return this.getStatus();
  }

  async getDecryptedGithubToken(userId: string): Promise<string | null> {
    const account = await this.prisma.linkedAccount.findUnique({
      where: { userId_platform: { userId, platform: GITHUB_PLATFORM } },
    });
    if (!account) return null;
    return this.crypto.decrypt(account.accessToken);
  }

  async removeGithubToken() {
    const userId = await this.localUser.getDefaultUserId();
    await this.prisma.linkedAccount.deleteMany({ where: { userId, platform: GITHUB_PLATFORM } });
    return this.getStatus();
  }

  async upsertItem(
    userId: string,
    item: {
      source: string;
      type: string;
      externalId: string | null;
      title: string;
      summary: string;
      skills: string[];
      url: string | null;
      metadata?: Record<string, any>;
    },
  ) {
    return this.prisma.knowledgeItem.upsert({
      where: { userId_source_externalId: { userId, source: item.source, externalId: item.externalId } },
      update: {
        title: item.title,
        summary: item.summary,
        skills: item.skills,
        url: item.url,
        metadata: item.metadata,
        syncedAt: new Date(),
      },
      create: {
        userId,
        source: item.source,
        type: item.type,
        externalId: item.externalId,
        title: item.title,
        summary: item.summary,
        skills: item.skills,
        url: item.url,
        metadata: item.metadata,
      },
    });
  }

  // Removes GitHub-sourced items that no longer qualify as worthwhile
  // (coursework, near-duplicate, near-empty scratch repos) — without this,
  // a repo that passed an earlier, less strict sync would linger forever.
  async pruneGithubItems(userId: string, keepExternalIds: string[]) {
    await this.prisma.knowledgeItem.deleteMany({
      where: { userId, source: 'github', externalId: { notIn: keepExternalIds } },
    });
  }

  // Ranks stored knowledge items against a job offer by keyword overlap and
  // returns the top few, formatted as prompt-ready text — replaces the
  // live, unauthenticated GitHub call previously made at CV-adaptation time.
  async getRelevantContext(userId: string, jobOffer: { title: string; description: string }): Promise<RelevantContext> {
    const items = await this.prisma.knowledgeItem.findMany({ where: { userId } });
    if (!items.length) return { text: '', items: [] };

    const offerTextNorm = normalize(`${jobOffer.title} ${jobOffer.description}`);

    const scored = items
      .map((item) => {
        const skillHits = item.skills.reduce((sum, skill) => sum + (offerTextNorm.includes(normalize(skill)) ? 1 : 0), 0);
        const titleHits = wordOverlapCount(offerTextNorm, item.title);
        const summaryHits = wordOverlapCount(offerTextNorm, item.summary);
        return { item, score: skillHits * 3 + titleHits * 2 + summaryHits };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 8)
      .filter((s) => s.score > 0);

    if (!scored.length) return { text: '', items: [] };

    const lines = scored.map(({ item }) => {
      const skills = item.skills.length ? ` [${item.skills.join(', ')}]` : '';
      return `- ${item.title}${skills} — ${item.summary || 'pas de description exploitable'}`;
    });

    return {
      text: `Base de connaissance du candidat (projets/expériences pertinents pour cette offre) :\n${lines.join('\n')}`,
      items: scored.map(({ item }) => item),
    };
  }
}
