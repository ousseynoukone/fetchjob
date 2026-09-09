import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { CampaignService } from './campaign.service';

function isSameDay(a: Date, b: Date): boolean {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

// Runs alongside the manual "Lancer" button in the UI — a campaign with
// `scheduleEnabled` fires on its own once a day at `scheduleHour`, without
// requiring the user to trigger it. Checked hourly rather than with a
// once-a-day cron expression so a server restart near the target hour still
// catches it within the same hour window.
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
      where: { scheduleEnabled: true, scheduleHour: now.getHours(), status: { not: 'running' } },
    });

    for (const campaign of campaigns) {
      if (campaign.lastRunAt && isSameDay(campaign.lastRunAt, now)) continue;

      this.logger.log(`Scheduled trigger for campaign ${campaign.id}`);
      try {
        await this.campaignService.run();
      } catch (error: any) {
        this.logger.warn(`Scheduled campaign run failed: ${error.message}`);
      }
    }
  }
}
