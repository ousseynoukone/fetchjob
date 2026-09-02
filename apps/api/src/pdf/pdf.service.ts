import { Injectable } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import { CVDocument, CVData } from './templates/cv-document';
import { CoverLetterDocument, CoverLetterData } from './templates/cover-letter-document';

@Injectable()
export class PdfService {
  async generateCVPdf(cv: CVData): Promise<Buffer> {
    return renderToBuffer(CVDocument({ cv }));
  }

  async generateCoverLetterPdf(letter: CoverLetterData): Promise<Buffer> {
    return renderToBuffer(CoverLetterDocument({ letter }));
  }
}
