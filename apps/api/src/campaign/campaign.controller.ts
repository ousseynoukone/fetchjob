import { Controller, Get, Put, Post, Body } from '@nestjs/common';
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

  @Get('runs')
  async getRuns() {
    return this.campaignService.getRunHistory();
  }

  @Get('stats')
  async getStats() {
    return this.campaignService.getStats();
  }
}
