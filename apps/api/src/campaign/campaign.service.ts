import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { CvService } from '../cv/cv.service';
import { ScrapingService } from '../scraping/scraping.service';
import { MatchingService } from '../matching/matching.service';
import { ApplicationPrepService } from '../applications/application-prep.service';
import { AutoApplyService } from '../auto-apply/auto-apply.service';
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

// JobOffer uniqueness is per (source, externalId), so the same posting
// cross-listed on e.g. LinkedIn and HelloWork creates two distinct JobOffer
// rows and would otherwise become two separate candidatures. Key on
// normalized title+company instead to catch that across sources.
function jobDedupeKey(title: string, company: string): string {
  return `${normalizeText(title)}|${normalizeText(company)}`;
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
  sources: ['linkedin', 'hellowork', 'indeed', 'france_travail', 'adzuna', 'welcome_to_the_jungle'] as string[],
};

// A candidature only tells us something about its source once it's past the
// "just prepared" stage — either it got sent (by the bot or by the user
// clicking through manually) or the bot tried and got blocked.
const ATTEMPTED_STATUSES = ['applied', 'needs_review'];

// Below this many attempts, a 0% success rate proves nothing — could just be
// bad luck on the first couple of postings.
const MIN_TRIALS_BEFORE_JUDGING = 8;
// A condemned source still gets one offer per run: platforms change (an
// anti-bot lifts, a redesign reopens a form), and giving up on them for good
// would mean never noticing.
const PROBE_QUOTA = 1;

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);
  private runningCampaigns = new Set<string>();
  // In-process only: this is a single-instance, single-user tool, so an
  // RxJS Subject is enough to fan a run's log lines out to any number of
  // connected browser tabs live, with no external broker needed. `done` lets
  // the frontend know the run ended without having to re-poll for it.
  private readonly logStream = new Subject<{ runId: string; type: 'log' | 'done'; message: string; at: string }>();

  streamLogs(): Observable<{ runId: string; type: 'log' | 'done'; message: string; at: string }> {
    return this.logStream.asObservable();
  }

  constructor(
    private prisma: PrismaService,
    private localUser: LocalUserService,
    private cvService: CvService,
    private scraping: ScrapingService,
    private matching: MatchingService,
    private prep: ApplicationPrepService,
    private autoApply: AutoApplyService,
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
    this.logStream.next({ runId, type: 'log', message, at: new Date().toISOString() });
  }

  // What each source has actually produced for this campaign so far — read
  // from the applications themselves rather than a separate counter, so it
  // can never drift from what really happened (an application deleted or
  // corrected by hand doesn't need to be reconciled anywhere else).
  private async performanceBySource(campaignId: string): Promise<Map<string, { essais: number; succes: number }>> {
    const rows = await this.prisma.application.findMany({
      where: { campaignId, status: { in: ATTEMPTED_STATUSES } },
      select: { status: true, jobOffer: { select: { source: true } } },
    });

    const perf = new Map<string, { essais: number; succes: number }>();
    for (const row of rows) {
      const current = perf.get(row.jobOffer.source) || { essais: 0, succes: 0 };
      current.essais += 1;
      if (row.status === 'applied') current.succes += 1;
      perf.set(row.jobOffer.source, current);
    }
    return perf;
  }

  // Caps how many candidatures a single run is allowed to prepare from each
  // source. Without this, one prolific source processed first exhausts the
  // whole day's quota before a later, more productive source is ever tried —
  // the loop below has no other point where a source's own budget runs out.
  // A source proven (over enough attempts) to never convert is knocked down
  // to a single probe per run; what it gives up is handed to the sources that
  // do convert, evenly.
  private async computeSourceQuotas(
    campaignId: string,
    sources: string[],
    dailyLimit: number,
  ): Promise<{ quotas: Map<string, number>; condemned: string[] }> {
    const perf = await this.performanceBySource(campaignId);
    const baseShare = Math.max(1, Math.ceil(dailyLimit / Math.max(sources.length, 1)));

    const quotas = new Map<string, number>();
    const condemned: string[] = [];
    let freed = 0;

    for (const source of sources) {
      const stat = perf.get(source) || { essais: 0, succes: 0 };
      const isCondemned = stat.essais >= MIN_TRIALS_BEFORE_JUDGING && stat.succes === 0;
      if (isCondemned) {
        condemned.push(source);
        freed += Math.max(0, baseShare - PROBE_QUOTA);
        quotas.set(source, PROBE_QUOTA);
      } else {
        quotas.set(source, baseShare);
      }
    }

    const productive = sources.filter((s) => !condemned.includes(s));
    if (freed > 0 && productive.length) {
      const share = Math.floor(freed / productive.length);
      const remainder = freed - share * productive.length;
      productive.forEach((source, idx) => {
        quotas.set(source, (quotas.get(source) || 0) + share + (idx < remainder ? 1 : 0));
      });
    }

    return { quotas, condemned };
  }

  private async executeRun(campaign: any, runId: string, userId: string) {
    let offersScanned = 0;
    let offersFiltered = 0;
    let applicationsPrepared = 0;
    const createdApplicationIds: string[] = [];

    try {
      const cv = await this.cvService.getCV(userId);
      const targetKeywords = (campaign.keywords as string[]) || [];

      // Seed with every existing candidature's title+company for this
      // campaign so a job already prepared from one source (in this run or
      // a previous one) doesn't get re-prepared just because another
      // source scraped it under a different externalId.
      const existingJobKeys = await this.prisma.application.findMany({
        where: { campaignId: campaign.id },
        select: { jobTitle: true, company: true },
      });
      const seenJobKeys = new Set(existingJobKeys.map((a) => jobDedupeKey(a.jobTitle, a.company)));

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

      // Redirects the day's quota away from sources that consume it without
      // ever converting (a platform's anti-bot blocking every attempt, or an
      // aggregator whose postings all turn out to redirect elsewhere) —
      // without this, a source processed early can quietly starve every
      // other source of budget it isn't actually using productively.
      const { quotas: sourceQuotas, condemned } = await this.computeSourceQuotas(
        campaign.id,
        campaign.sources as string[],
        campaign.maxApplicationsPerDay,
      );
      if (condemned.length) {
        await this.appendLog(
          runId,
          `Quota réduit à ${PROBE_QUOTA} sonde pour : ${condemned.join(', ')} (0 succès sur au moins ${MIN_TRIALS_BEFORE_JUDGING} essais) — repris par les sources qui convertissent.`,
        );
      }
      const preparedPerSource = new Map<string, number>();

      // Query-outer, source-inner: each query is tried across every source
      // before moving to the next query. Looping sources-outer would let the
      // first source alone exhaust the daily cap, so later sources (and
      // later queries) would never even get tried in a given run.
      for (const query of searchQueries) {
        for (const source of campaign.sources as string[]) {
          if (applicationsPrepared >= campaign.maxApplicationsPerDay) break;

          const sourceQuota = sourceQuotas.get(source) ?? campaign.maxApplicationsPerDay;
          if ((preparedPerSource.get(source) || 0) >= sourceQuota) continue;

          await this.appendLog(runId, `Recherche "${query}" sur ${source}...`);

          const offers = await this.scraping.fetchOffers(source, {
            keywords: query,
            location: campaign.location,
            contractTypes: campaign.contractTypes,
          });

          offersScanned += offers.length;
          await this.appendLog(runId, `${offers.length} offre(s) trouvée(s) sur ${source} pour "${query}"`);

          for (const rawOffer of offers) {
            if (applicationsPrepared >= campaign.maxApplicationsPerDay) break;
            if ((preparedPerSource.get(source) || 0) >= sourceQuota) break;

            if (!isWithinIdf(rawOffer.source, rawOffer.location, campaign.location)) {
              offersFiltered++;
              continue;
            }

            const excludeKeywords = (campaign.excludeKeywords as string[]) || [];
            if (excludeKeywords.length) {
              const haystack = `${rawOffer.title} ${rawOffer.description}`.toLowerCase();
              const excluded = excludeKeywords.some((kw) => kw.trim() && haystack.includes(kw.trim().toLowerCase()));
              if (excluded) {
                offersFiltered++;
                continue;
              }
            }

            if (campaign.maxAgeMonths > 0 && rawOffer.postedAt) {
              const cutoff = new Date();
              cutoff.setMonth(cutoff.getMonth() - campaign.maxAgeMonths);
              if (rawOffer.postedAt < cutoff) {
                offersFiltered++;
                continue;
              }
            }

            // Only fetched now, after every filter has already passed — the
            // early filters run cheap, so this avoids spending a detail-page
            // request (LinkedIn/HelloWork) on an offer that was going to be
            // discarded anyway.
            const offer = await this.scraping.enrichDescription(rawOffer);

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
            if (existingApplication) {
              // Still surfaced by this run and still pending — keep it counted
              // as "current" instead of letting it fall into Historique just
              // because it isn't a brand-new candidature this time.
              if (existingApplication.status === 'to_apply' && existingApplication.campaignRunId !== runId) {
                await this.prisma.application.update({
                  where: { id: existingApplication.id },
                  data: { campaignRunId: runId },
                });
              }
              continue;
            }

            const jobKey = jobDedupeKey(jobOffer.title, jobOffer.company);
            if (seenJobKeys.has(jobKey)) {
              offersFiltered++;
              await this.appendLog(
                runId,
                `Doublon ignoré: ${jobOffer.title} chez ${jobOffer.company} (déjà vu sur une autre source)`,
              );
              continue;
            }

            const result = this.matching.match(
              cv,
              {
                title: jobOffer.title,
                description: jobOffer.description,
                location: jobOffer.location || '',
              },
              targetKeywords,
              (campaign.seniorityKeywords as string[]) || [],
            );

            if (result.score < campaign.minMatchScore) {
              offersFiltered++;
              if (result.seniorityMismatch) {
                await this.appendLog(
                  runId,
                  `Filtré (niveau senior/lead, profil junior): ${jobOffer.title} chez ${jobOffer.company}`,
                );
              }
              continue;
            }

            const application = await this.prisma.application.create({
              data: {
                userId,
                campaignId: campaign.id,
                campaignRunId: runId,
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

            seenJobKeys.add(jobKey);
            applicationsPrepared++;
            preparedPerSource.set(source, (preparedPerSource.get(source) || 0) + 1);
            createdApplicationIds.push(application.id);
            await this.appendLog(
              runId,
              `Candidature préparée: ${jobOffer.title} chez ${jobOffer.company} (score ${result.score})`,
            );

            try {
              const { failures, errorMessage } = await this.prep.prepareMaterials(application.id, cv, jobOffer, userId);
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

      if (campaign.actionMode === 'auto_apply' && createdApplicationIds.length) {
        await this.appendLog(runId, `Auto-apply: soumission de ${createdApplicationIds.length} candidature(s)...`);
        const { applied, needsReview } = await this.autoApply.run({
          userId,
          applicationIds: createdApplicationIds,
          atsEnabled: campaign.autoApplyAts,
          minDelaySeconds: campaign.autoApplyMinDelaySeconds,
          maxDelaySeconds: campaign.autoApplyMaxDelaySeconds,
          appendLog: (message) => this.appendLog(runId, message),
        });
        await this.appendLog(runId, `Auto-apply terminé: ${applied} envoyée(s), ${needsReview} à vérifier.`);
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
      this.logStream.next({ runId, type: 'done', message: error.message, at: new Date().toISOString() });
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
    this.logStream.next({ runId, type: 'done', message: '', at: new Date().toISOString() });
  }
}
