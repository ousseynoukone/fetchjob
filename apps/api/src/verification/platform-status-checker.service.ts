import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import type { Page } from 'playwright';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { SettingsService } from '../common/settings.service';
import { PlatformCredentialsService } from '../platform-credentials/platform-credentials.service';
import { SupportedPlatform } from '../platform-credentials/dto/upsert-credential.dto';
import { BrowserSessionService } from '../auto-apply/browser-session.service';
import { blockHeavyResources, dismissCookieBanner } from '../auto-apply/appliers/ats-common';
import { BrowserConcurrencyService } from '../common/browser-concurrency.service';

declare const document: any;

const DEFAULT_INTERVAL_HOURS = 12;
const MAX_PAGES_PER_PLATFORM = 8; // ~80 most recent candidatures — open (applied/needs_review) rows are always recent, so this comfortably covers them without re-walking the full history every run.

interface ScrapedRow {
  status: string;
  jobTitle: string;
  company: string;
}

interface PlatformHandler {
  // Scrapes that platform's own "my applications" page and returns every row
  // it can read, most-recent first. Only rows whose native status maps to a
  // real verdict (see REJECTED_STATUS_LABELS below) are acted on — anything
  // else (seen/pending/self-reported states) is left alone.
  listUrl: (pageNum: number) => string;
  rejectedLabels: RegExp;
}

// Confirmed live (2026-09-25) by scraping a real HelloWork account's
// mes-candidatures.html: each entry's own status line is one of "Envoyée",
// "Consultée", "A finaliser" (an incomplete draft) or "Refusée". "Refusée"
// only appears for recruiters using HelloWork's own recruiter/ATS tooling
// ("Super recruteur" badge) — HelloWork propagates their rejection
// automatically, with no self-report question shown underneath. For every
// other recruiter, HelloWork has no signal and instead asks the candidate
// "Avez-vous eu un retour du recruteur ?" — that self-reported case is
// intentionally NOT treated as a detection here, since it isn't the
// platform telling us anything.
const PLATFORM_HANDLERS: Partial<Record<SupportedPlatform, PlatformHandler>> = {
  hellowork: {
    listUrl: (p) => `https://www.hellowork.com/fr-fr/candidat/mes-candidatures.html?p=${p}`,
    rejectedLabels: /^Refusée$/i,
  },
};

function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\bh\s*f\b|\bf\s*h\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordOverlap(a: string, b: string): number {
  const setA = new Set(normalize(a).split(' ').filter((w) => w.length >= 3));
  const setB = new Set(normalize(b).split(' ').filter((w) => w.length >= 3));
  if (!setA.size || !setB.size) return 0;
  let shared = 0;
  for (const w of setA) if (setB.has(w)) shared++;
  return shared / Math.min(setA.size, setB.size);
}

// Complements ApplicationResponseTrackerService (Gmail-based) with a second
// detection source: some platforms show an application's outcome directly
// on their own site, and a recruiter replying there generates no email at
// all — confirmed live for HelloWork specifically, at the user's request
// ("il faut prendre ça en compte aussi... pour les autres plateformes il
// faudra que tu vérifies dans tous les cas"). Only HelloWork is wired up so
// far (PLATFORM_HANDLERS above) — other account-based platforms
// (LinkedIn/Indeed/France Travail) were not confirmed to expose an
// equivalent native, non-self-reported status during this investigation;
// adding one is just a new PLATFORM_HANDLERS entry once confirmed live the
// same way.
@Injectable()
export class PlatformStatusCheckerService {
  private readonly logger = new Logger(PlatformStatusCheckerService.name);

  constructor(
    private prisma: PrismaService,
    private localUser: LocalUserService,
    private settings: SettingsService,
    private credentials: PlatformCredentialsService,
    private browserSession: BrowserSessionService,
    private browserConcurrency: BrowserConcurrencyService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkAndScan() {
    try {
      await this.run();
    } catch (error: any) {
      this.logger.warn(`Platform-status scan failed: ${error.message}`);
    }
  }

  private async run() {
    const lastCheckedAt = await this.settings.getLastPlatformStatusCheckAt();
    const intervalRaw = await this.settings.get('platformStatusCheckIntervalHours');
    const intervalHours = Number(intervalRaw) > 0 ? Number(intervalRaw) : DEFAULT_INTERVAL_HOURS;

    if (lastCheckedAt) {
      const dueAt = new Date(lastCheckedAt.getTime() + intervalHours * 3_600_000);
      if (new Date() < dueAt) return;
    }

    const userId = await this.localUser.getDefaultUserId();

    for (const platform of Object.keys(PLATFORM_HANDLERS) as SupportedPlatform[]) {
      await this.checkPlatform(userId, platform).catch((error: any) => {
        this.logger.warn(`Platform-status scan failed for ${platform}: ${error.message}`);
      });
    }

    await this.settings.setLastPlatformStatusCheckAt(new Date());
  }

  private async checkPlatform(userId: string, platform: SupportedPlatform) {
    const handler = PLATFORM_HANDLERS[platform];
    if (!handler) return;

    const open = await this.prisma.application.findMany({
      where: { userId, status: { in: ['applied', 'needs_review'] }, jobOffer: { source: platform } },
      select: { id: true, company: true, jobTitle: true, status: true },
    });
    if (!open.length) return;

    let sessionState: string | null = null;
    try {
      sessionState = (await this.credentials.getDecrypted(userId, platform)).sessionState;
    } catch {
      return;
    }
    if (!sessionState) return;

    await this.browserConcurrency.runExclusive(`platform-status:${platform}`, () =>
      this.scanPlatform(platform, handler, open, sessionState!),
    );
  }

  private async scanPlatform(
    platform: SupportedPlatform,
    handler: PlatformHandler,
    open: { id: string; company: string; jobTitle: string; status: string }[],
    sessionState: string,
  ) {
    const context = await this.browserSession.createContext(sessionState);
    await blockHeavyResources(context);
    const remaining = new Set(open.map((a) => a.id));
    let matchedCount = 0;

    try {
      const page = await context.newPage();
      for (let p = 1; p <= MAX_PAGES_PER_PLATFORM && remaining.size > matchedCount; p++) {
        const rows = await this.scrapeListingPage(page, handler.listUrl(p));
        if (!rows.length) break;

        for (const row of rows) {
          if (!handler.rejectedLabels.test(row.status)) continue;

          const match = open.find(
            (a) =>
              remaining.has(a.id) &&
              normalize(a.company) === normalize(row.company) &&
              (normalize(a.jobTitle) === normalize(row.jobTitle) || wordOverlap(a.jobTitle, row.jobTitle) >= 0.7),
          );
          if (!match) continue;

          matchedCount++;
          remaining.delete(match.id);
          const platformLabel = platform === 'hellowork' ? 'HelloWork' : platform;
          await this.prisma.application
            .update({
              where: { id: match.id },
              data: {
                status: 'rejected',
                rejectedAt: new Date(),
                hasUnseenUpdate: true,
                autoUpdateSummary: `Refus détecté directement sur ${platformLabel} (${row.company}).`,
                autoUpdateAt: new Date(),
                autoUpdateVerdict: 'rejected',
                autoUpdateSource: platform,
                // Deterministic, not AI-generated: the exact status label
                // read off the platform's own "mes candidatures" page for
                // this row, plus the page it was read from, so the claim
                // can be checked directly instead of just trusted.
                autoUpdateEvidence: `Statut affiché sur la page "Mes candidatures" de ${platformLabel} pour "${row.jobTitle}" chez ${row.company} : "${row.status}"\nPage : ${handler.listUrl(p)}`,
              },
            })
            .catch((error: any) => {
              this.logger.warn(`Failed to record ${platform} rejection for ${match.id}: ${error.message}`);
            });
          this.logger.log(`${platform} : refus détecté pour "${match.jobTitle}" chez ${match.company}.`);
        }
      }
    } finally {
      await context.close().catch(() => {});
    }
  }

  private async scrapeListingPage(page: Page, url: string): Promise<ScrapedRow[]> {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    await dismissCookieBanner(page).catch(() => {});
    await page.waitForTimeout(2500);

    return page.evaluate(() => {
      const items = [...document.querySelectorAll('li.mb-6')];
      return items
        .map((li: any) => {
          const lines = ((li.innerText as string) || '')
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean);
          return { status: lines[0] || '', jobTitle: lines[1] || '', company: lines[2] || '' };
        })
        .filter((r) => r.status && r.jobTitle && r.company);
    });
  }
}
