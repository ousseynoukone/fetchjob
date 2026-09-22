import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { CampaignService } from './campaign.service';

// The hours a campaign should fire at today: `runsPerDay` slots spread
// evenly over the 24h starting at `scheduleHour` (3/day from 08:00 gives
// 08:00, 16:00, 00:00). Clamped to at most one run an hour, since that is
// how often this service wakes up.
function scheduledHours(scheduleHour: number, runsPerDay: number): number[] {
  const runs = Math.min(Math.max(runsPerDay, 1), 24);
  const interval = Math.max(1, Math.floor(24 / runs));
  return Array.from({ length: runs }, (_, i) => (scheduleHour + i * interval) % 24);
}

// Runs alongside the manual "Lancer" button in the UI — a campaign with
// `scheduleEnabled` fires on its own, without requiring the user to trigger
// it, `runsPerDay` times a day starting at `scheduleHour`. Checked hourly
// rather than with a cron expression per slot so a server restart near a
// target hour still catches it within the same hour window.
@Injectable()
export class CampaignSchedulerService {
  private readonly logger = new Logger(CampaignSchedulerService.name);

  constructor(
    private prisma: PrismaService,
    private campaignService: CampaignService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkScheduledCampaigns() {
    const now = new Date();
    const campaigns = await this.prisma.campaign.findMany({
      where: { scheduleEnabled: true, status: { not: 'running' } },
    });

    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    const startOfHour = new Date(now);
    startOfHour.setMinutes(0, 0, 0);

    for (const campaign of campaigns) {
      if (campaign.scheduleHour === null || campaign.scheduleHour === undefined) continue;
      if (!scheduledHours(campaign.scheduleHour, campaign.runsPerDay).includes(now.getHours())) continue;

      // Counted from the runs themselves rather than `lastRunAt`, which a
      // manual launch also updates: a run started by hand shouldn't silently
      // eat one of the day's scheduled slots.
      const runsToday = await this.prisma.campaignRun.count({
        where: { campaignId: campaign.id, startedAt: { gte: startOfDay } },
      });
      if (runsToday >= campaign.runsPerDay) continue;

      // This service wakes up hourly, so without this a slot could fire twice
      // if the hour is checked more than once.
      const runThisHour = await this.prisma.campaignRun.count({
        where: { campaignId: campaign.id, startedAt: { gte: startOfHour } },
      });
      if (runThisHour > 0) continue;

      this.logger.log(
        `Scheduled trigger for campaign ${campaign.id} (${runsToday + 1}/${campaign.runsPerDay} today)`,
      );
      try {
        await this.campaignService.run();
      } catch (error: any) {
        this.logger.warn(`Scheduled campaign run failed: ${error.message}`);
      }
    }
  }
}
