import { Injectable, Logger } from '@nestjs/common';
import { Subject, Observable } from 'rxjs';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { PlatformCredentialsService } from '../platform-credentials/platform-credentials.service';
import { SUPPORTED_PLATFORMS, SupportedPlatform } from '../platform-credentials/dto/upsert-credential.dto';
import { BrowserSessionService } from '../auto-apply/browser-session.service';
import {
  dismissCookieBanner,
  hasSecurityCheck,
  hasAlreadyAppliedIndicator,
  blockHeavyResources,
} from '../auto-apply/appliers/ats-common';

export interface VerificationStreamEvent {
  runId: string;
  type: 'log' | 'done';
  message: string;
  at: string;
}

// A manually-launched pass, separate from auto-apply itself: revisits every
// "applied" candidature that isn't confirmed yet, on its own offer page,
// using the platform's stored session — an independent check that the
// platform actually recorded the application, rather than trusting whatever
// the apply flow displayed on screen at the time. Only the four
// account-based platforms are checkable this way (ATS-hosted postings and
// aggregators don't have a "my applications" state to read without a login
// tied to that specific system).
@Injectable()
export class VerificationService {
  private readonly logger = new Logger(VerificationService.name);
  private running = false;
  private readonly logStream = new Subject<VerificationStreamEvent>();

  constructor(
    private prisma: PrismaService,
    private localUser: LocalUserService,
    private credentials: PlatformCredentialsService,
    private browserSession: BrowserSessionService,
  ) {}

  streamLogs(): Observable<VerificationStreamEvent> {
    return this.logStream.asObservable();
  }

  async getLatestRun() {
    const userId = await this.localUser.getDefaultUserId();
    return this.prisma.verificationRun.findFirst({ where: { userId }, orderBy: { startedAt: 'desc' } });
  }

  async getRunHistory() {
    const userId = await this.localUser.getDefaultUserId();
    return this.prisma.verificationRun.findMany({
      where: { userId },
      orderBy: { startedAt: 'desc' },
      take: 10,
    });
  }

  async run() {
    if (this.running) return this.getLatestRun();
    const userId = await this.localUser.getDefaultUserId();

    const verificationRun = await this.prisma.verificationRun.create({
      data: { userId, logs: ['Vérification démarrée'] },
    });

    this.running = true;
    this.executeRun(verificationRun.id, userId).catch((error: any) => {
      this.logger.error(`Verification run ${verificationRun.id} crashed: ${error.message}`);
    });

    return verificationRun;
  }

  private async appendLog(runId: string, message: string) {
    const run = await this.prisma.verificationRun.findUnique({ where: { id: runId } });
    const logs = [...(run?.logs || []), message];
    await this.prisma.verificationRun.update({ where: { id: runId }, data: { logs } });
    this.logStream.next({ runId, type: 'log', message, at: new Date().toISOString() });
  }

  private async executeRun(runId: string, userId: string) {
    let checked = 0;
    let confirmed = 0;
    let unconfirmed = 0;

    try {
      const applications = await this.prisma.application.findMany({
        where: {
          userId,
          status: 'applied',
          verifiedAt: null,
          jobOffer: { source: { in: [...SUPPORTED_PLATFORMS] } },
        },
        include: { jobOffer: true },
      });

      if (!applications.length) {
        await this.appendLog(
          runId,
          "Rien à vérifier : aucune candidature 'envoyée' en attente de confirmation sur une plateforme vérifiable (LinkedIn, Indeed, France Travail, HelloWork).",
        );
        await this.finishRun(runId, { checked, confirmed, unconfirmed });
        return;
      }

      const byPlatform = new Map<string, typeof applications>();
      for (const application of applications) {
        const list = byPlatform.get(application.jobOffer.source) || [];
        list.push(application);
        byPlatform.set(application.jobOffer.source, list);
      }

      for (const [platform, apps] of byPlatform) {
        let sessionState: string | null = null;
        try {
          sessionState = (await this.credentials.getDecrypted(userId, platform as SupportedPlatform)).sessionState;
        } catch {
          await this.appendLog(runId, `${platform} : aucune session établie — ${apps.length} candidature(s) ignorée(s).`);
          continue;
        }
        if (!sessionState) {
          await this.appendLog(runId, `${platform} : session expirée — ${apps.length} candidature(s) ignorée(s).`);
          continue;
        }

        const context = await this.browserSession.createContext(sessionState);
        await blockHeavyResources(context);
        try {
          for (const application of apps) {
            checked++;
            const label = `${application.jobTitle} chez ${application.company}`;
            try {
              const page = await context.newPage();
              await page.goto(application.sourceUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
              await dismissCookieBanner(page);

              if (await hasSecurityCheck(page)) {
                unconfirmed++;
                await this.prisma.application.update({
                  where: { id: application.id },
                  data: { verificationNote: 'Vérification impossible : contrôle de sécurité affiché par la plateforme.' },
                });
                await this.appendLog(runId, `${label} : contrôle de sécurité, vérification impossible.`);
              } else if (await hasAlreadyAppliedIndicator(page)) {
                confirmed++;
                await this.prisma.application.update({
                  where: { id: application.id },
                  data: { verifiedAt: new Date(), verificationNote: null },
                });
                await this.appendLog(runId, `Confirmé : ${label}`);
              } else {
                unconfirmed++;
                await this.prisma.application.update({
                  where: { id: application.id },
                  data: {
                    verificationNote:
                      "Aucune confirmation détectée sur la page de l'offre — à vérifier manuellement.",
                  },
                });
                await this.appendLog(runId, `Non confirmé : ${label}`);
              }
              await page.close().catch(() => {});
            } catch (error: any) {
              unconfirmed++;
              await this.appendLog(runId, `Erreur en vérifiant ${label} : ${error.message}`);
            }

            await this.browserSession.randomDelay(2000, 5000);
          }
        } finally {
          await context.close().catch(() => {});
        }
      }

      await this.appendLog(
        runId,
        `Terminé : ${checked} vérifiée(s), ${confirmed} confirmée(s), ${unconfirmed} non confirmée(s).`,
      );
      await this.finishRun(runId, { checked, confirmed, unconfirmed });
    } catch (error: any) {
      this.logger.error(error);
      await this.appendLog(runId, `Erreur : ${error.message}`);
      await this.prisma.verificationRun.update({
        where: { id: runId },
        data: { finishedAt: new Date(), error: error.message, checked, confirmed, unconfirmed },
      });
      this.running = false;
      this.logStream.next({ runId, type: 'done', message: error.message, at: new Date().toISOString() });
    }
  }

  private async finishRun(runId: string, stats: { checked: number; confirmed: number; unconfirmed: number }) {
    await this.prisma.verificationRun.update({ where: { id: runId }, data: { finishedAt: new Date(), ...stats } });
    this.running = false;
    this.logStream.next({ runId, type: 'done', message: '', at: new Date().toISOString() });
  }
}
