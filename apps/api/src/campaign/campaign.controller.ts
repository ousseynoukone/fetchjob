import { Controller, Get, Put, Post, Body, Sse, MessageEvent } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { CampaignService } from './campaign.service';
import { UpdateCampaignDto } from './dto/update-campaign.dto';

@Controller('campagne')
export class CampaignController {
  constructor(private campaignService: CampaignService) {}

  @Get()
  async getCampaign() {
    return this.campaignService.getOrCreateCampaign();
  }

  @Put()
  async updateCampaign(@Body() dto: UpdateCampaignDto) {
    return this.campaignService.updateCampaign(dto);
  }

  @Post('run')
  async runCampaign() {
    return this.campaignService.run();
  }

  @Post('pause')
  async pauseCampaign() {
    return this.campaignService.pause();
  }

  @Get('logs')
  async getLogs() {
    return this.campaignService.getLatestRun();
  }

  // Pushes each candidature-by-candidature log line the moment it's written,
  // instead of the frontend re-polling /campagne/logs on a timer — a real
  // "suivre en direct" view instead of a few-seconds-stale snapshot. Plain
  // SSE (not a websocket) since this is one-way, server-to-browser only.
  @Sse('stream')
  streamLogs(): Observable<MessageEvent> {
    return this.campaignService.streamLogs().pipe(map((event) => ({ data: event })));
  }

  @Get('runs')
  async getRuns() {
    return this.campaignService.getRunHistory();
  }

  @Get('stats')
  async getStats() {
    return this.campaignService.getStats();
  }
}
