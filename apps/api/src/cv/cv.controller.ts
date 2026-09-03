import { Controller, Get, Put, Post, Delete, Body, Res } from '@nestjs/common';
import type { Response } from 'express';
import { CvService } from './cv.service';
import { PdfService } from '../pdf/pdf.service';
import { UpdateCvDto } from './dto/update-cv.dto';

@Controller('cv')
export class CvController {
  constructor(
    private cvService: CvService,
    private pdfService: PdfService,
  ) {}

  @Get()
  async getCV() {
    const userId = await this.cvService.getDefaultUserId();
    return this.cvService.getCV(userId);
  }

  @Put()
  async updateCV(@Body() dto: UpdateCvDto) {
    const userId = await this.cvService.getDefaultUserId();
    return this.cvService.updateCV(userId, dto);
  }

  @Post()
  async createCV(@Body() data: any) {
    const userId = await this.cvService.getDefaultUserId();
    return this.cvService.createOrUpdateCV(userId, data);
  }

  @Delete()
  async deleteCV() {
    const userId = await this.cvService.getDefaultUserId();
    return this.cvService.deleteCV(userId);
  }

  @Get('preview')
  async getPreview() {
    const userId = await this.cvService.getDefaultUserId();
    return this.cvService.getPreview(userId);
  }

  @Get('pdf')
  async getPdf(@Res() res: Response) {
    const userId = await this.cvService.getDefaultUserId();
    const cv = await this.cvService.getCV(userId);
    const pdf = await this.pdfService.generateCVPdf(cv as any);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="CV OUSSEYNOU KONE.pdf"',
      'Content-Length': pdf.length,
    });
    res.send(pdf);
  }
}
