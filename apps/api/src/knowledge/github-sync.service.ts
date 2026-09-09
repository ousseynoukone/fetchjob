import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { GithubService, GithubFullRepoInfo } from '../github/github.service';
import { KnowledgeService } from './knowledge.service';
import { LocalUserService } from '../common/local-user.service';

const DIACRITICS_REGEX = new RegExp('[\\u0300-\\u036f]', 'g');

function normalizeName(name: string): string {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_REGEX, '')
    .replace(/[^a-z0-9]+/g, '');
}

// Coursework/scratch repo names — confirmed live: "DevoirLaravel" and
// similar homework repos were being synced alongside real projects, diluting
// (and sometimes outranking, by sheer keyword luck) genuinely worthwhile work.
// The lookahead accepts a following uppercase letter as a boundary too
// (not just a separator or end-of-string), since these repos are often
// named without any separator at all ("DevoirLaravel", not "Devoir-Laravel").
const JUNK_NAME_PATTERN = /(^|[-_.])(devoir|tp\d*|test|exercice|exo\d*|essai|sandbox|demo|hello[-_]?world|untitled|scratch|temp|tmp|wip)(?=[-_.]|\d*$|[A-Z]|$)/i;

// Combines every signal already gathered (real README, real dependencies,
// structural maturity, description/topics, stars, size) into one score used
// both to drop near-empty scratch repos and to pick a winner among
// near-duplicate pushes of the same small project (confirmed live:
// "tech-space" / "TechSpace" / "tech_space" all synced as separate items).
function worthinessScore(repo: GithubFullRepoInfo): number {
  let score = 0;
  // A bare "# repo-name" README (confirmed live) is technically non-empty
  // but carries zero real information — only reward README length that
  // could plausibly describe something.
  if (repo.readmeExcerpt.length > 40) score += 3;
  score += Math.min(repo.dependencies.length, 10) * 0.5;
  score += repo.structureSignals.length * 2;
  if (repo.description) score += 1;
  score += Math.min(repo.topics.length, 5) * 0.5;
  score += Math.min(repo.stars, 10) * 0.5;
  score += Math.min(repo.sizeKb / 200, 5);
  return score;
}

// Excludes coursework/scratch repos by name, then keeps only the
// highest-scoring repo among near-duplicate names (same project pushed
// under slightly different casing/separators), then drops whatever's left
// with no real signal of substance at all (empty scratch repos).
function selectWorthwhileRepos(repos: GithubFullRepoInfo[]): GithubFullRepoInfo[] {
  const named = repos.filter((r) => !JUNK_NAME_PATTERN.test(r.name));

  const byNormalizedName = new Map<string, GithubFullRepoInfo>();
  for (const repo of named) {
    const key = normalizeName(repo.name);
    const existing = byNormalizedName.get(key);
    if (!existing || worthinessScore(repo) > worthinessScore(existing)) {
      byNormalizedName.set(key, repo);
    }
  }

  const MIN_WORTHINESS = 1;
  return [...byNormalizedName.values()].filter((r) => worthinessScore(r) >= MIN_WORTHINESS);
}

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

  async syncForDefaultUser(): Promise<{ synced: number; skipped: number }> {
    const userId = await this.localUser.getDefaultUserId();
    const token = await this.knowledge.getDecryptedGithubToken(userId);
    if (!token) {
      return { synced: 0, skipped: 0 };
    }

    const allRepos = await this.github.listAllRepos(token);
    const worthwhile = selectWorthwhileRepos(allRepos);

    // Sequential rather than Promise.all: keeps Neon's pooled connection
    // usage bounded, and a personal GitHub account's repo count is small
    // enough that the extra latency doesn't matter.
    for (const repo of worthwhile) {
      const skills = [...new Set([repo.language, ...repo.topics, ...repo.dependencies].filter((v): v is string => !!v))];

      // README/description first; when neither exists (common for repos
      // without a written README), fall back to the real dependencies list
      // so the repo still contributes *something* rather than nothing.
      const baseSummary = [repo.description, repo.readmeExcerpt].filter(Boolean).join(' — ');
      const fallbackSummary = repo.dependencies.length
        ? `Dépendances détectées : ${repo.dependencies.slice(0, 8).join(', ')}`
        : '';
      const structureNote = repo.structureSignals.length ? repo.structureSignals.join(', ') : '';
      const summary = [baseSummary || fallbackSummary, structureNote].filter(Boolean).join(' — ');

      await this.knowledge.upsertItem(userId, {
        source: 'github',
        type: 'repo',
        externalId: repo.externalId,
        title: repo.name,
        summary,
        skills,
        url: repo.url,
        metadata: { stars: repo.stars, private: repo.private, pushedAt: repo.pushedAt },
      });
    }

    // Repos that used to be worthwhile (or existed before this filter) but
    // no longer qualify — coursework, near-duplicates, near-empty scratch
    // repos — shouldn't linger in the knowledge base from a previous sync.
    const keepExternalIds = worthwhile.map((r) => r.externalId);
    await this.knowledge.pruneGithubItems(userId, keepExternalIds);

    const skipped = allRepos.length - worthwhile.length;
    this.logger.log(`GitHub sync: ${worthwhile.length} repo(s) kept, ${skipped} skipped (coursework/duplicate/empty)`);
    return { synced: worthwhile.length, skipped };
  }
}
