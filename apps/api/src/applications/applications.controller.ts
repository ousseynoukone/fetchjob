import { Controller, Get, Patch, Post, Delete, Param, Query, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { ApplicationsService } from './applications.service';
import { PdfService } from '../pdf/pdf.service';
import { UpdateStatusDto } from './dto/update-status.dto';
import { AddManualOfferDto } from './dto/add-manual.dto';

@Controller('candidatures')
export class ApplicationsController {
  constructor(
    private applicationsService: ApplicationsService,
    private pdfService: PdfService,
  ) {}

  @Get()
  async list(@Query('status') status?: string, @Query('scope') scope?: 'current' | 'history') {
    return this.applicationsService.list(status, scope);
  }

  @Post('manual')
  async addManual(@Body() dto: AddManualOfferDto) {
    return this.applicationsService.addManual(dto);
  }

  @Delete()
  async removeAll(@Query('status') status?: string) {
    return this.applicationsService.removeAll(status);
  }

  @Get(':id')
  async getById(@Param('id') id: string) {
    return this.applicationsService.getById(id);
  }

  @Patch(':id/status')
  async updateStatus(@Param('id') id: string, @Body() dto: UpdateStatusDto) {
    return this.applicationsService.updateStatus(id, dto.status);
  }

  @Post(':id/apply')
  async apply(@Param('id') id: string) {
    return this.applicationsService.markApplied(id);
  }

  @Post(':id/regen')
  async regenerate(@Param('id') id: string) {
    return this.applicationsService.regenerate(id);
  }

  @Delete(':id')
  async remove(@Param('id') id: string) {
    return this.applicationsService.remove(id);
  }

  @Get(':id/cv')
  async getCv(@Param('id') id: string, @Res() res: Response) {
    const cv = await this.applicationsService.getCvData(id);
    const pdf = await this.pdfService.generateCVPdf(cv);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="CV OUSSEYNOU KONE.pdf"',
      'Content-Length': pdf.length,
    });
    res.send(pdf);
  }

  @Get(':id/lettre')
  async getCoverLetterPdf(@Param('id') id: string, @Res() res: Response) {
    const application = await this.applicationsService.getById(id);
    const cv = await this.applicationsService.getCvData(id);

    const pdf = await this.pdfService.generateCoverLetterPdf({
      fullName: cv.fullName,
      email: cv.email,
      phone: cv.phone,
      location: cv.location,
      company: application.company,
      jobTitle: application.jobTitle,
      body: application.coverLetter || '',
    });

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="lettre-de-motivation.pdf"',
      'Content-Length': pdf.length,
    });
    res.send(pdf);
  }
}
