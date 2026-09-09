import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { SettingsService } from '../common/settings.service';
import { EmailService } from './email.service';

const DEFAULT_INTERVAL_HOURS = 4;

// Sends one summary email covering every candidature sent since the last
// digest, instead of one email per candidature — checked hourly, but only
// actually sends once `digestIntervalHours` have really passed, the same
// "check often, act rarely" pattern as the campaign scheduler.
@Injectable()
export class DigestService {
  private readonly logger = new Logger(DigestService.name);

  constructor(
    private prisma: PrismaService,
    private localUser: LocalUserService,
    private settings: SettingsService,
    private email: EmailService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkAndSend() {
    try {
      await this.run();
    } catch (error: any) {
      this.logger.warn(`Digest check failed: ${error.message}`);
    }
  }

  private async run() {
    const lastSentAt = await this.settings.getLastDigestSentAt();

    // First run ever: don't dump the entire history of past candidatures
    // into one email — just start the clock from now.
    if (!lastSentAt) {
      await this.settings.setLastDigestSentAt(new Date());
      return;
    }

    const intervalRaw = await this.settings.get('digestIntervalHours');
    const intervalHours = Number(intervalRaw) > 0 ? Number(intervalRaw) : DEFAULT_INTERVAL_HOURS;
    const dueAt = new Date(lastSentAt.getTime() + intervalHours * 3_600_000);
    if (new Date() < dueAt) return;

    const userId = await this.localUser.getDefaultUserId();

    const [sent, needsReview] = await Promise.all([
      this.prisma.application.findMany({
        where: { userId, status: 'applied', appliedAt: { gt: lastSentAt } },
        include: { jobOffer: true },
        orderBy: { appliedAt: 'asc' },
      }),
      this.prisma.application.count({
        where: { userId, status: 'needs_review', updatedAt: { gt: lastSentAt } },
      }),
    ]);

    // Still move the clock forward even with nothing to report — otherwise
    // a quiet period would make the very next digest fire immediately once
    // something finally happens, instead of waiting out the interval.
    await this.settings.setLastDigestSentAt(new Date());

    if (!sent.length && !needsReview) return;

    await this.email.sendDigestEmail(
      sent.map((application) => ({
        id: application.id,
        jobTitle: application.jobTitle,
        company: application.company,
        jobOfferUrl: application.jobOffer.url,
      })),
      needsReview,
    );
  }
}
