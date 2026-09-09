import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AiService } from '../ai/ai.service';
import { KnowledgeService } from '../knowledge/knowledge.service';
import type { GithubRepoInfo } from '../github/github.service';

export interface PrepResult {
  application: any;
  failures: string[];
  errorMessage?: string;
}

function extractMessage(reason: any): string {
  // The OpenAI SDK (and DeepSeek via the same SDK) throws APIError objects
  // that carry the provider's real message under `.error.message`, distinct
  // from the generic HTTP status text — surface that, not just "failed".
  return reason?.error?.message || reason?.message || String(reason);
}

@Injectable()
export class ApplicationPrepService {
  private readonly logger = new Logger(ApplicationPrepService.name);

  constructor(
    private prisma: PrismaService,
    private ai: AiService,
    private knowledge: KnowledgeService,
  ) {}

  async prepareMaterials(applicationId: string, cv: any, jobOffer: any, userId: string): Promise<PrepResult> {
    const context = await this.knowledge.getRelevantContext(userId, jobOffer);
    const extraContext = [cv.additionalContext, context.text].filter(Boolean).join('\n\n');

    // adaptCvBullets' anti-fabrication check needs the GitHub-shaped repo
    // info (name/language/readmeExcerpt) to ground any new "project" bullet
    // it proposes — reconstruct it from the ranked knowledge items instead
    // of the old live, unauthenticated GitHub fetch.
    const githubRepos: GithubRepoInfo[] = context.items
      .filter((item) => item.source === 'github')
      .map((item) => ({
        name: item.title,
        language: item.skills[0] || null,
        url: item.url || '',
        readmeExcerpt: item.summary,
      }));

    const [adaptedCv, coverLetter, analysis] = await Promise.allSettled([
      this.ai.adaptCvBullets(cv, jobOffer, cv.additionalContext, githubRepos),
      this.ai.generateCoverLetter(cv, jobOffer, extraContext),
      this.ai.analyzeOffer(cv, jobOffer, extraContext),
    ]);

    const failures: string[] = [];
    let errorMessage: string | undefined;

    if (adaptedCv.status === 'rejected') {
      failures.push('CV adapté');
      errorMessage = extractMessage(adaptedCv.reason);
      this.logger.warn(`adaptCvBullets failed: ${adaptedCv.reason}`);
    }
    if (coverLetter.status === 'rejected') {
      failures.push('Lettre de motivation');
      errorMessage = errorMessage || extractMessage(coverLetter.reason);
      this.logger.warn(`generateCoverLetter failed: ${coverLetter.reason}`);
    }
    if (analysis.status === 'rejected') {
      failures.push('Analyse IA');
      errorMessage = errorMessage || extractMessage(analysis.reason);
      this.logger.warn(`analyzeOffer failed: ${analysis.reason}`);
    }

    const application = await this.prisma.application.update({
      where: { id: applicationId },
      data: {
        adaptedCvData: adaptedCv.status === 'fulfilled' ? adaptedCv.value : undefined,
        coverLetter: coverLetter.status === 'fulfilled' ? coverLetter.value : undefined,
        aiAnalysis: analysis.status === 'fulfilled' ? analysis.value : undefined,
      },
      include: { jobOffer: true },
    });

    return { application, failures, errorMessage };
  }
}
