import { Module } from '@nestjs/common';
import { CvService } from './cv.service';
import { CvController } from './cv.controller';
import { CommonModule } from '../common/common.module';
import { PdfModule } from '../pdf/pdf.module';

@Module({
  imports: [CommonModule, PdfModule],
  providers: [CvService],
  controllers: [CvController],
  exports: [CvService],
})
export class CvModule {}
