import { Controller, Get, Put, Post, Body, Sse, MessageEvent } from '@nestjs/common';
import { Observable, map } from 'rxjs';
import { CampaignService } from './campaign.service';
import { AutoApplyService } from '../auto-apply/auto-apply.service';
import { UpdateCampaignDto } from './dto/update-campaign.dto';

@Controller('campagne')
export class CampaignController {
  constructor(
    private campaignService: CampaignService,
    private autoApplyService: AutoApplyService,
  ) {}

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

  // Re-attempts every candidature currently "à vérifier" — typically run
  // right after answering whatever question blocked it (see /api/questions)
  // or fixing whatever else was wrong. Shows up in the same Journal/live-view
  // panels as a normal run, since it's backed by the same CampaignRun.
  @Post('retry-failed')
  async retryFailed() {
    return this.campaignService.retryFailed();
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

  // Live view of the browser during an auto-apply attempt — a stream of
  // screenshots taken as fast as Chromium renders them (CDP screencast),
  // not a saved recording. Frames only exist while a candidature is
  // actively being applied to; between attempts (or in prepare_only mode)
  // this stream simply stays quiet.
  @Sse('live-view')
  streamLiveView(): Observable<MessageEvent> {
    return this.autoApplyService.streamFrames().pipe(map((event) => ({ data: event })));
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
