import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { CvService } from '../cv/cv.service';
import { ScrapingService } from '../scraping/scraping.service';
import { MatchingService } from '../matching/matching.service';
import { ApplicationPrepService } from '../applications/application-prep.service';
import { UpdateCampaignDto } from './dto/update-campaign.dto';

const IDF_LOCATION_TERMS = [
  'ile de france', 'paris', 'seine et marne', 'yvelines', 'essonne',
  'hauts de seine', 'seine saint denis', 'val de marne', 'val d oise',
  '(75)', '(77)', '(78)', '(91)', '(92)', '(93)', '(94)', '(95)',
];

const DIACRITICS_REGEX = new RegExp('[\\u0300-\\u036f]', 'g');

function normalizeText(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(DIACRITICS_REGEX, '')
    .replace(/[-']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// The scraping APIs' own location matching is best-effort (France Travail's
// commune/region params, Adzuna's free-text `where`) — verify locally rather
// than trust every result actually sits in the requested area. Remotive is a
// remote-only board (location strings like "Worldwide"/"EU", not literally
// "remote"), so it's exempt entirely rather than parsed. Unrecognized
// location strings pass too, rather than risk discarding a genuinely good
// match on missing metadata.
function isWithinIdf(source: string, offerLocation: string | undefined, campaignLocation: string): boolean {
  if (source === 'remotive' || source === 'jobicy') return true;
  if (normalizeText(campaignLocation) !== 'ile de france') return true;
  if (!offerLocation) return true;

  const normalized = normalizeText(offerLocation);
  if (normalized.includes('remote') || normalized.includes('teletravail')) return true;

  return IDF_LOCATION_TERMS.some((term) => normalized.includes(term));
}

const DEFAULT_CAMPAIGN = {
  jobTitle: '',
  location: '',
  remote: false,
  contractTypes: [] as string[],
  keywords: [] as string[],
  excludeKeywords: [] as string[],
  maxAgeMonths: 0,
  maxApplicationsPerDay: 10,
  minMatchScore: 60,
  actionMode: 'prepare_only',
  sources: ['linkedin', 'hellowork', 'indeed', 'france_travail', 'adzuna'] as string[],
};

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);
  private runningCampaigns = new Set<string>();

  constructor(
    private prisma: PrismaService,
    private localUser: LocalUserService,
    private cvService: CvService,
    private scraping: ScrapingService,
    private matching: MatchingService,
    private prep: ApplicationPrepService,
  ) {}

  async getOrCreateCampaign() {
    const userId = await this.localUser.getDefaultUserId();
    const existing = await this.prisma.campaign.findFirst({ where: { userId } });
    if (existing) return existing;

    return this.prisma.campaign.create({
      data: { userId, ...DEFAULT_CAMPAIGN },
    });
  }

  async updateCampaign(dto: UpdateCampaignDto) {
    const campaign = await this.getOrCreateCampaign();
    return this.prisma.campaign.update({
      where: { id: campaign.id },
      data: dto,
    });
  }

  async getStats() {
    const campaign = await this.getOrCreateCampaign();
    return {
      status: campaign.status,
      totalOffersScanned: campaign.totalOffersScanned,
      totalOffersFiltered: campaign.totalOffersFiltered,
      totalApplicationsPrepared: campaign.totalApplicationsPrepared,
      totalApplicationsSent: campaign.totalApplicationsSent,
      lastRunAt: campaign.lastRunAt,
    };
  }

  async getLatestRun() {
    const campaign = await this.getOrCreateCampaign();
    return this.prisma.campaignRun.findFirst({
      where: { campaignId: campaign.id },
      orderBy: { startedAt: 'desc' },
    });
  }

  async getRunHistory() {
    const campaign = await this.getOrCreateCampaign();
    return this.prisma.campaignRun.findMany({
      where: { campaignId: campaign.id },
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
  }

  async pause() {
    const campaign = await this.getOrCreateCampaign();
    return this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'paused' },
    });
  }

  async run() {
    const campaign = await this.getOrCreateCampaign();

    if (this.runningCampaigns.has(campaign.id)) {
      return this.getLatestRun();
    }

    const userId = await this.localUser.getDefaultUserId();

    const run = await this.prisma.campaignRun.create({
      data: { campaignId: campaign.id, userId, logs: ['Campagne démarrée'] },
    });

    this.runningCampaigns.add(campaign.id);
    await this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'running' },
    });

    // Fire-and-forget: the frontend polls /campagne/logs for progress.
    this.executeRun(campaign, run.id, userId).catch((err) => {
      this.logger.error(`Campaign run ${run.id} crashed: ${err.message}`);
    });

    return run;
  }

  private async appendLog(runId: string, message: string) {
    const run = await this.prisma.campaignRun.findUnique({ where: { id: runId } });
    const logs = [...(run?.logs || []), message];
    await this.prisma.campaignRun.update({ where: { id: runId }, data: { logs } });
  }

  private async executeRun(campaign: any, runId: string, userId: string) {
    let offersScanned = 0;
    let offersFiltered = 0;
    let applicationsPrepared = 0;

    try {
      const cv = await this.cvService.getCV(userId);
      const targetKeywords = (campaign.keywords as string[]) || [];

      // Each keyword is run as its own separate search query (never ANDed
      // together — a query built from the full list would match nothing).
      // Capped at 50 as a safety net against an accidentally huge keyword
      // list; the query-outer loop below already stops issuing further
      // searches as soon as maxApplicationsPerDay is reached, so this cap
      // is about guarding against degenerate input, not API-call budget.
      const searchQueries = targetKeywords.length
        ? targetKeywords.slice(0, 50)
        : campaign.jobTitle
          ? [campaign.jobTitle]
          : [];

      if (!searchQueries.length) {
        await this.appendLog(runId, "Aucun poste ou mot-clé défini, campagne annulée.");
        await this.finishRun(campaign.id, runId, { offersScanned, offersFiltered, applicationsPrepared });
        return;
      }

      // Query-outer, source-inner: each query is tried across every source
      // before moving to the next query. Looping sources-outer would let the
      // first source alone exhaust the daily cap, so later sources (and
      // later queries) would never even get tried in a given run.
      for (const query of searchQueries) {
        for (const source of campaign.sources as string[]) {
          if (applicationsPrepared >= campaign.maxApplicationsPerDay) break;

          await this.appendLog(runId, `Recherche "${query}" sur ${source}...`);

          const offers = await this.scraping.fetchOffers(source, {
            keywords: query,
            location: campaign.location,
            contractTypes: campaign.contractTypes,
          });

          offersScanned += offers.length;
          await this.appendLog(runId, `${offers.length} offre(s) trouvée(s) sur ${source} pour "${query}"`);

          for (const offer of offers) {
            if (applicationsPrepared >= campaign.maxApplicationsPerDay) break;

            if (!isWithinIdf(offer.source, offer.location, campaign.location)) {
              offersFiltered++;
              continue;
            }

            const excludeKeywords = (campaign.excludeKeywords as string[]) || [];
            if (excludeKeywords.length) {
              const haystack = `${offer.title} ${offer.description}`.toLowerCase();
              const excluded = excludeKeywords.some((kw) => kw.trim() && haystack.includes(kw.trim().toLowerCase()));
              if (excluded) {
                offersFiltered++;
                continue;
              }
            }

            if (campaign.maxAgeMonths > 0 && offer.postedAt) {
              const cutoff = new Date();
              cutoff.setMonth(cutoff.getMonth() - campaign.maxAgeMonths);
              if (offer.postedAt < cutoff) {
                offersFiltered++;
                continue;
              }
            }

            const jobOffer = await this.prisma.jobOffer.upsert({
              where: { source_externalId: { source: offer.source, externalId: offer.externalId } },
              update: {},
              create: {
                externalId: offer.externalId,
                source: offer.source,
                title: offer.title,
                company: offer.company,
                location: offer.location,
                description: offer.description,
                url: offer.url,
                contractType: offer.contractType,
                salary: offer.salary,
                postedAt: offer.postedAt,
              },
            });

            const existingApplication = await this.prisma.application.findUnique({
              where: { campaignId_jobOfferId: { campaignId: campaign.id, jobOfferId: jobOffer.id } },
            });
            if (existingApplication) continue;

            const result = this.matching.match(
              cv,
              {
                title: jobOffer.title,
                description: jobOffer.description,
                location: jobOffer.location || '',
              },
              targetKeywords,
            );

            if (result.score < campaign.minMatchScore) {
              offersFiltered++;
              continue;
            }

            const application = await this.prisma.application.create({
              data: {
                userId,
                campaignId: campaign.id,
                jobOfferId: jobOffer.id,
                jobTitle: jobOffer.title,
                company: jobOffer.company,
                location: jobOffer.location,
                sourceUrl: jobOffer.url,
                matchScore: result.score,
                matchedSkills: result.matchedSkills,
                missingSkills: result.missingSkills,
              },
            });

            applicationsPrepared++;
            await this.appendLog(
              runId,
              `Candidature préparée: ${jobOffer.title} chez ${jobOffer.company} (score ${result.score})`,
            );

            try {
              const { failures, errorMessage } = await this.prep.prepareMaterials(application.id, cv, jobOffer);
              if (failures.length) {
                await this.appendLog(
                  runId,
                  `Préparation IA partielle (échec: ${failures.join(', ')})${errorMessage ? ` — ${errorMessage}` : ''}`,
                );
              }
            } catch (prepError: any) {
              // Don't let one candidature's AI prep failure abort the whole run.
              this.logger.warn(`prepareMaterials crashed for ${application.id}: ${prepError.message}`);
            }
          }
        }
      }

      if (campaign.actionMode === 'auto_apply') {
        await this.appendLog(
          runId,
          "Mode auto-apply activé mais non implémenté (soumission automatique désactivée par sécurité) — candidatures laissées en 'à postuler'.",
        );
      }

      await this.appendLog(runId, `Terminé: ${applicationsPrepared} candidature(s) préparée(s).`);
      await this.finishRun(campaign.id, runId, { offersScanned, offersFiltered, applicationsPrepared });
    } catch (error: any) {
      this.logger.error(error);
      await this.appendLog(runId, `Erreur: ${error.message}`);
      await this.prisma.campaignRun.update({
        where: { id: runId },
        data: { finishedAt: new Date(), error: error.message, offersScanned, offersFiltered, applicationsPrepared },
      });
      await this.prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'active' } });
      this.runningCampaigns.delete(campaign.id);
    }
  }

  private async finishRun(
    campaignId: string,
    runId: string,
    stats: { offersScanned: number; offersFiltered: number; applicationsPrepared: number },
  ) {
    await this.prisma.campaignRun.update({
      where: { id: runId },
      data: { finishedAt: new Date(), ...stats },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: 'active',
        lastRunAt: new Date(),
        totalOffersScanned: { increment: stats.offersScanned },
        totalOffersFiltered: { increment: stats.offersFiltered },
        totalApplicationsPrepared: { increment: stats.applicationsPrepared },
      },
    });

    this.runningCampaigns.delete(campaignId);
  }
}
