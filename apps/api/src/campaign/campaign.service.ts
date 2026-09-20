import { Injectable, Logger, BadRequestException, NotFoundException, OnModuleInit } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { CvService } from '../cv/cv.service';
import { ScrapingService } from '../scraping/scraping.service';
import { MatchingService } from '../matching/matching.service';
import { ApplicationPrepService } from '../applications/application-prep.service';
import { AutoApplyService } from '../auto-apply/auto-apply.service';
import { UpdateCampaignDto } from './dto/update-campaign.dto';
import { normalizeText, locationWithinRegion } from '../common/location-region';

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

  return locationWithinRegion(offerLocation, campaignLocation) === 'yes';
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



@Injectable()
export class CampaignService implements OnModuleInit {
  private readonly logger = new Logger(CampaignService.name);
  private runningCampaigns = new Set<string>();
  // Guards against genuinely concurrent execution. run()/retryFailed()/
  // retryOne() each check-then-set `runningCampaigns` only after one or
  // more `await`s (the campaign's own id isn't known any sooner) — a real
  // race window: two nearly-simultaneous calls (a double-clicked "Lancer",
  // or a retry click landing while the main run is still going) can both
  // pass the check before either sets it, launching two genuinely
  // concurrent executions that then fight over the single shared
  // browser/renderer budget. Confirmed live: three consecutive apply
  // attempts each timed out ~85s apart — less than the 120s per-attempt
  // budget, meaning the next one's clock was already running before the
  // previous one's had finished, which sequential execution alone can't
  // produce. Checked and set synchronously, before any await, so there is
  // no window left for a second call to slip through.
  private launchInProgress = false;
  // Set by pause() while executeRun's background task for that campaign is
  // still in flight — checked between offers/sources/queries (and passed
  // into AutoApplyService for its own between-candidature check) so
  // "Pause" actually stops the run soon instead of only preventing the
  // *next* one, which is all flipping `campaign.status` to 'paused' alone
  // ever did.
  private cancelledCampaigns = new Set<string>();
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

  // On startup, any campaign still marked 'running' in the DB is a
  // ghost run left over from a previous process that crashed or was
  // restarted while a campaign was in progress — reset them to 'active'
  // so they can be re-triggered normally, and mark their open campaign_runs
  // as finished so the frontend doesn't keep showing stale logs.
  async onModuleInit() {
    try {
      // Mark orphaned running campaigns as active
      await this.prisma.campaign.updateMany({
        where: { status: 'running' },
        data: { status: 'active' },
      });
      // Close any campaign_runs that never got a finishedAt
      await this.prisma.campaignRun.updateMany({
        where: { finishedAt: null },
        data: { finishedAt: new Date(), error: 'Process restarted — run interrupted.' },
      });
      this.logger.log('Cleaned up orphaned running campaigns on startup.');
    } catch (err: any) {
      this.logger.warn(`onModuleInit cleanup failed: ${err.message}`);
    }
  }

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
    this.cancelledCampaigns.add(campaign.id);
    return this.prisma.campaign.update({
      where: { id: campaign.id },
      data: { status: 'paused' },
    });
  }

  async run() {
    if (this.launchInProgress) {
      return this.getLatestRun();
    }
    this.launchInProgress = true;
    let handedOff = false;

    try {
      const campaign = await this.getOrCreateCampaign();

      const latestRun = await this.getLatestRun();
      if (this.runningCampaigns.has(campaign.id)) {
        if (latestRun && latestRun.finishedAt) {
          this.logger.log(`Clearing stale in-memory runningCampaigns flag for campaign ${campaign.id}`);
          this.runningCampaigns.delete(campaign.id);
          this.cancelledCampaigns.delete(campaign.id);
        } else {
          return latestRun;
        }
      }
      // Reset ghost-running state left in DB after a server restart
      if (campaign.status === 'running') {
        await this.prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'active' } });
        await this.prisma.campaignRun.updateMany({
          where: { campaignId: campaign.id, finishedAt: null },
          data: { finishedAt: new Date(), error: 'Nouvelle campagne lancée — run précédente interrompue.' },
        });
      }

      const userId = await this.localUser.getDefaultUserId();

      const run = await this.prisma.campaignRun.create({
        data: { campaignId: campaign.id, userId, logs: ['Campagne démarrée'] },
      });

      this.runningCampaigns.add(campaign.id);
      this.cancelledCampaigns.delete(campaign.id);
      await this.prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: 'running' },
      });

      // Fire-and-forget: the frontend polls /campagne/logs for progress.
      // launchInProgress is released once this actually finishes (see the
      // .finally below), not by this method returning — it must stay locked
      // for the whole background execution, not just this setup.
      handedOff = true;
      this.executeRun(campaign, run.id, userId)
        .catch((err) => {
          this.logger.error(`Campaign run ${run.id} crashed: ${err.message}`);
        })
        .finally(() => {
          this.launchInProgress = false;
        });

      return run;
    } finally {
      if (!handedOff) this.launchInProgress = false;
    }
  }

  // Re-attempts every candidature currently marked "à vérifier" — most
  // useful right after answering whatever question or fixing whatever
  // problem blocked it the first time (see CustomQuestionsService: a
  // learned answer is reused automatically the next time the same
  // question comes up, on any platform). Reuses AutoApplyService.run()
  // directly rather than the whole scrape-and-prepare pipeline, and the
  // exact same CampaignRun/log-stream/live-view infrastructure a normal
  // run uses, so nothing new was needed on the frontend to watch it happen.
  async retryFailed() {
    if (this.launchInProgress) {
      return this.getLatestRun();
    }
    this.launchInProgress = true;
    let handedOff = false;

    try {
      const campaign = await this.getOrCreateCampaign();

      const latestRun = await this.getLatestRun();
      if (this.runningCampaigns.has(campaign.id)) {
        if (latestRun && latestRun.finishedAt) {
          this.logger.log(`Clearing stale in-memory runningCampaigns flag for retryFailed ${campaign.id}`);
          this.runningCampaigns.delete(campaign.id);
          this.cancelledCampaigns.delete(campaign.id);
        } else {
          return latestRun;
        }
      }
      // Also reset ghost-running state left in DB after a restart
      if (campaign.status === 'running') {
        await this.prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'active' } });
        await this.prisma.campaignRun.updateMany({
          where: { campaignId: campaign.id, finishedAt: null },
          data: { finishedAt: new Date(), error: 'Relancé manuellement — run précédente interrompue.' },
        });
      }

      const userId = await this.localUser.getDefaultUserId();
      const failed = await this.prisma.application.findMany({
        where: { userId, status: 'needs_review' },
        select: { id: true },
      });

      if (!failed.length) {
        throw new BadRequestException('Aucune candidature "à vérifier" pour le moment.');
      }

      const run = await this.prisma.campaignRun.create({
        data: {
          campaignId: campaign.id,
          userId,
          logs: [`Nouvelle tentative sur ${failed.length} candidature(s) à vérifier...`],
        },
      });

      this.runningCampaigns.add(campaign.id);
      this.cancelledCampaigns.delete(campaign.id);
      await this.prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'running' } });

      handedOff = true;
      this.executeRetry(campaign, run.id, userId, failed.map((a) => a.id))
        .catch((err) => {
          this.logger.error(`Retry run ${run.id} crashed: ${err.message}`);
        })
        .finally(() => {
          this.launchInProgress = false;
        });

      return run;
    } finally {
      if (!handedOff) this.launchInProgress = false;
    }
  }

  // Re-attempts a SINGLE targeted candidature on demand
  async retryOne(applicationId: string) {
    if (this.launchInProgress) {
      return this.getLatestRun();
    }
    this.launchInProgress = true;
    let handedOff = false;

    try {
      const campaign = await this.getOrCreateCampaign();

      // Also guard against ghost-running state left in the DB after a restart
      if (this.runningCampaigns.has(campaign.id) || campaign.status === 'running') {
        // Reset the ghost state so the user can retry immediately
        if (!this.runningCampaigns.has(campaign.id) && campaign.status === 'running') {
          await this.prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'active' } });
          await this.prisma.campaignRun.updateMany({
            where: { campaignId: campaign.id, finishedAt: null },
            data: { finishedAt: new Date(), error: 'Relancé manuellement — run précédente interrompue.' },
          });
        } else {
          return this.getLatestRun();
        }
      }

      const userId = await this.localUser.getDefaultUserId();
      const app = await this.prisma.application.findFirst({
        where: { id: applicationId, userId },
        select: { id: true, jobTitle: true, company: true },
      });

      if (!app) {
        throw new NotFoundException('Candidature introuvable.');
      }

      const run = await this.prisma.campaignRun.create({
        data: {
          campaignId: campaign.id,
          userId,
          logs: [`Nouvelle tentative ciblée sur : ${app.jobTitle} chez ${app.company}...`],
        },
      });

      this.runningCampaigns.add(campaign.id);
      this.cancelledCampaigns.delete(campaign.id);
      await this.prisma.campaign.update({ where: { id: campaign.id }, data: { status: 'running' } });

      handedOff = true;
      this.executeRetry(campaign, run.id, userId, [app.id])
        .catch((err) => {
          this.logger.error(`Retry run ${run.id} crashed: ${err.message}`);
        })
        .finally(() => {
          this.launchInProgress = false;
        });

      return run;
    } finally {
      if (!handedOff) this.launchInProgress = false;
    }
  }

  private async executeRetry(campaign: any, runId: string, userId: string, applicationIds: string[]) {
    try {
      const { applied, needsReview, cancelled } = await this.autoApply.run({
        userId,
        applicationIds,
        atsEnabled: campaign.autoApplyAts,
        minDelaySeconds: campaign.autoApplyMinDelaySeconds,
        maxDelaySeconds: campaign.autoApplyMaxDelaySeconds,
        appendLog: (message) => this.appendLog(runId, message),
        isCancelled: () => this.cancelledCampaigns.has(campaign.id),
      });

      await this.appendLog(
        runId,
        `Terminé : ${applied} envoyée(s), ${needsReview} toujours à vérifier.${cancelled ? ' (arrêté)' : ''}`,
      );
      await this.finishRun(
        campaign.id,
        runId,
        { offersScanned: 0, offersFiltered: 0, applicationsPrepared: 0 },
        cancelled ? 'paused' : 'active',
      );
    } catch (error: any) {
      this.logger.error(error);
      await this.appendLog(runId, `Erreur : ${error.message}`);
      await this.prisma.campaignRun.update({
        where: { id: runId },
        data: { finishedAt: new Date(), error: error.message },
      });
      await this.prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: this.cancelledCampaigns.has(campaign.id) ? 'paused' : 'active' },
      });
      this.runningCampaigns.delete(campaign.id);
      this.cancelledCampaigns.delete(campaign.id);
      this.logStream.next({ runId, type: 'done', message: error.message, at: new Date().toISOString() });
    }
  }

  private async appendLog(runId: string, message: string) {
    const run = await this.prisma.campaignRun.findUnique({ where: { id: runId } });
    const logs = [...(run?.logs || []), message];
    await this.prisma.campaignRun.update({ where: { id: runId }, data: { logs } });
    this.logStream.next({ runId, type: 'log', message, at: new Date().toISOString() });
  }



  // How many candidatures have already been prepared today for each source,
  // across every run — a manual "Lancer" on top of the scheduled run must
  // not let a source blow past its own daily limit just because the count
  // Count how many candidatures are CONFIRMED submitted today (status: 'applied')
  // for each source. "À vérifier" (needs_review) or failed attempts do NOT count:
  // the daily quota strictly tracks confirmed successful applications.
  private async confirmedTodayBySource(campaignId: string): Promise<Map<string, number>> {
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const rows = await this.prisma.application.findMany({
      where: {
        campaignId,
        status: 'applied',
        appliedAt: { gte: startOfDay },
      },
      select: { jobOffer: { select: { source: true } } },
    });

    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(row.jobOffer.source, (counts.get(row.jobOffer.source) || 0) + 1);
    }
    return counts;
  }

  // Each source's own remaining budget for today — completely independent
  // of every other source. Limits are strictly determined by the user's
  // configuration (either sourceDailyLimits per platform or maxApplicationsPerDay).
  // No automated circuit breaker or probe penalty overrides user preferences.
  private async computeSourceBudgets(
    campaign: { id: string; maxApplicationsPerDay: number; sourceDailyLimits: unknown },
    sources: string[],
  ): Promise<Map<string, number>> {
    const confirmedToday = await this.confirmedTodayBySource(campaign.id);
    const overrides = (campaign.sourceDailyLimits || {}) as Record<string, number>;

    const remaining = new Map<string, number>();

    for (const source of sources) {
      const configuredLimit = Number(overrides[source]);
      const dailyLimit = configuredLimit > 0 ? configuredLimit : campaign.maxApplicationsPerDay;
      const alreadyConfirmed = confirmedToday.get(source) || 0;
      remaining.set(source, Math.max(0, dailyLimit - alreadyConfirmed));
    }

    return remaining;
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
      // list; the loop below already stops searching a given source once
      // its own daily budget runs out, so this cap is about guarding
      // against degenerate input, not API-call budget.
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

      // Each source's daily limit is its own — see computeSourceBudgets.
      // There is no shared/global cap across sources: daily limits are strictly
      // determined by what the user configured in the UI.
      const sourceBudgets = await this.computeSourceBudgets(campaign, campaign.sources as string[]);
      const preparedPerSource = new Map<string, number>();
      let cancelled = false;

      // Query-outer, source-inner: each query is tried across every source
      // before moving to the next query. Looping sources-outer would let the
      // first source alone exhaust its budget before later sources (and
      // later queries) are even tried in a given run.
      queries: for (const query of searchQueries) {
        for (const source of campaign.sources as string[]) {
          if (this.cancelledCampaigns.has(campaign.id)) {
            cancelled = true;
            break queries;
          }

          const sourceBudget = sourceBudgets.get(source) ?? campaign.maxApplicationsPerDay;
          if ((preparedPerSource.get(source) || 0) >= sourceBudget) continue;

          await this.appendLog(runId, `Recherche "${query}" sur ${source}...`);

          const offers = await this.scraping.fetchOffers(source, {
            keywords: query,
            location: campaign.location,
            contractTypes: campaign.contractTypes,
          });

          offersScanned += offers.length;
          await this.appendLog(runId, `${offers.length} offre(s) trouvée(s) sur ${source} pour "${query}"`);

          for (const rawOffer of offers) {
            if (this.cancelledCampaigns.has(campaign.id)) {
              cancelled = true;
              break queries;
            }
            if ((preparedPerSource.get(source) || 0) >= sourceBudget) break;

            if (!isWithinIdf(rawOffer.source, rawOffer.location, campaign.location)) {
              offersFiltered++;
              await this.appendLog(
                runId,
                `Filtré (hors Ile-de-France): ${rawOffer.title} chez ${rawOffer.company} (${rawOffer.location || 'lieu non précisé'})`,
              );
              continue;
            }

            // Confirmed live: matching against the full DESCRIPTION (not just
            // the title) made common team-structure words in "excludeKeywords"
            // -- "manager", "senior", "team lead" -- match almost any
            // professional job posting somewhere in its body text (e.g. "sous
            // la responsabilité du manager produit"), even when the ROLE
            // itself isn't senior/managerial at all. A real run with exactly
            // this exclude list silently filtered 515 of 518 scanned offers,
            // and this filter step had no logging at all (unlike the other
            // two filter checks), making it invisible from the run log. Title-
            // only now: "stage"/"alternance"/".Net" are naturally title-level
            // signals anyway, and genuine seniority filtering already has its
            // own, more careful mechanism (seniorityKeywords + minMatchScore
            // below) that penalizes rather than hard-excludes.
            const excludeKeywords = (campaign.excludeKeywords as string[]) || [];
            if (excludeKeywords.length) {
              const titleLower = rawOffer.title.toLowerCase();
              const excluded = excludeKeywords.some((kw) => kw.trim() && titleLower.includes(kw.trim().toLowerCase()));
              if (excluded) {
                offersFiltered++;
                await this.appendLog(
                  runId,
                  `Filtré (mot-clé à écarter dans le titre): ${rawOffer.title} chez ${rawOffer.company}`,
                );
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
              campaign.location,
            );

            if (result.score < campaign.minMatchScore) {
              offersFiltered++;
              // Confirmed live: this only ever logged the seniority-mismatch
              // case -- a low score for any OTHER reason (or just a strict
              // minMatchScore relative to genuinely relevant postings' own
              // real scores) filtered completely silently, on top of the
              // other two filter steps having the exact same gap. A real run
              // filtered 570 of 576 scanned offers with not one line
              // explaining why any single one of them was rejected.
              await this.appendLog(
                runId,
                result.seniorityMismatch
                  ? `Filtré (niveau senior/lead, profil junior): ${jobOffer.title} chez ${jobOffer.company}`
                  : `Filtré (score ${result.score} < seuil ${campaign.minMatchScore}): ${jobOffer.title} chez ${jobOffer.company}`,
              );
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

      if (cancelled) {
        await this.appendLog(runId, 'Campagne arrêtée (pause demandée) — auto-apply non lancé.');
        await this.finishRun(campaign.id, runId, { offersScanned, offersFiltered, applicationsPrepared }, 'paused');
        return;
      }

      // Count applications already CONFIRMED today per source (status: 'applied' only).
      // "À vérifier" (needs_review) or failed attempts do NOT count against the limit.
      const confirmedToday = await this.confirmedTodayBySource(campaign.id);

      // Query candidate applications in 'to_apply' (newly created + pending)
      const pendingApps = await this.prisma.application.findMany({
        where: {
          campaignId: campaign.id,
          status: 'to_apply',
        },
        include: { jobOffer: { select: { source: true } } },
        orderBy: [
          { matchScore: 'desc' },
          { createdAt: 'desc' },
        ],
      });

      const overrides = (campaign.sourceDailyLimits || {}) as Record<string, number>;
      const selectedBySource = new Map<string, number>();
      const toApplyIds: string[] = [];

      // Prioritize newly created applications from this run, then pending by match score
      const newlyCreatedSet = new Set(createdApplicationIds);
      const sortedApps = [
        ...pendingApps.filter((a) => newlyCreatedSet.has(a.id)),
        ...pendingApps.filter((a) => !newlyCreatedSet.has(a.id)),
      ];

      for (const app of sortedApps) {
        const source = app.jobOffer?.source || 'unknown';
        const configuredLimit = Number(overrides[source]);
        const dailyLimit = configuredLimit > 0 ? configuredLimit : campaign.maxApplicationsPerDay;
        const alreadyConfirmed = confirmedToday.get(source) || 0;

        if (alreadyConfirmed >= dailyLimit) continue; // daily quota of confirmed applications already reached

        // Queue enough candidates so that if one fails into 'needs_review' (à vérifier),
        // the runner can keep trying until the confirmed quota is achieved.
        const remainingNeeded = dailyLimit - alreadyConfirmed;
        const maxCandidatesToQueue = Math.max(remainingNeeded * 2, remainingNeeded + 2);
        const selected = selectedBySource.get(source) || 0;

        if (selected < maxCandidatesToQueue) {
          toApplyIds.push(app.id);
          selectedBySource.set(source, selected + 1);
        }
      }

      if (campaign.actionMode === 'auto_apply' && toApplyIds.length) {
        const summaryParts: string[] = [];
        for (const [source, count] of selectedBySource.entries()) {
          const confirmed = confirmedToday.get(source) || 0;
          const configuredLimit = Number(overrides[source]);
          const limit = configuredLimit > 0 ? configuredLimit : campaign.maxApplicationsPerDay;
          summaryParts.push(`${count} sur ${source} (${confirmed}/${limit} confirmée(s) aujourd'hui)`);
        }
        await this.appendLog(
          runId,
          `Auto-apply: sélection de ${toApplyIds.length} candidature(s) (${summaryParts.join(', ')})...`,
        );
        const { applied, needsReview, cancelled: autoApplyCancelled } = await this.autoApply.run({
          userId,
          applicationIds: toApplyIds,
          atsEnabled: campaign.autoApplyAts,
          minDelaySeconds: campaign.autoApplyMinDelaySeconds,
          maxDelaySeconds: campaign.autoApplyMaxDelaySeconds,
          appendLog: (message) => this.appendLog(runId, message),
          isCancelled: () => this.cancelledCampaigns.has(campaign.id),
          sourceDailyLimits: overrides,
          maxApplicationsPerDay: campaign.maxApplicationsPerDay,
        });
        await this.appendLog(runId, `Auto-apply terminé: ${applied} envoyée(s), ${needsReview} à vérifier.`);

        if (autoApplyCancelled) {
          await this.appendLog(runId, 'Campagne arrêtée (pause demandée) pendant l\'auto-apply.');
          await this.finishRun(campaign.id, runId, { offersScanned, offersFiltered, applicationsPrepared }, 'paused');
          return;
        }
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
      // A crash mid-run shouldn't leave the campaign stuck as 'paused' if a
      // pause happened to be requested around the same time, but it also
      // shouldn't overwrite an intentional pause with 'active' — only fall
      // back to 'active' when this crash wasn't itself the result of one.
      await this.prisma.campaign.update({
        where: { id: campaign.id },
        data: { status: this.cancelledCampaigns.has(campaign.id) ? 'paused' : 'active' },
      });
      this.runningCampaigns.delete(campaign.id);
      this.cancelledCampaigns.delete(campaign.id);
      this.logStream.next({ runId, type: 'done', message: error.message, at: new Date().toISOString() });
    }
  }

  private async finishRun(
    campaignId: string,
    runId: string,
    stats: { offersScanned: number; offersFiltered: number; applicationsPrepared: number },
    finalStatus: 'active' | 'paused' = 'active',
  ) {
    await this.prisma.campaignRun.update({
      where: { id: runId },
      data: { finishedAt: new Date(), ...stats },
    });

    await this.prisma.campaign.update({
      where: { id: campaignId },
      data: {
        status: finalStatus,
        lastRunAt: new Date(),
        totalOffersScanned: { increment: stats.offersScanned },
        totalOffersFiltered: { increment: stats.offersFiltered },
        totalApplicationsPrepared: { increment: stats.applicationsPrepared },
      },
    });

    this.runningCampaigns.delete(campaignId);
    this.cancelledCampaigns.delete(campaignId);
    this.logStream.next({ runId, type: 'done', message: '', at: new Date().toISOString() });
  }
}
