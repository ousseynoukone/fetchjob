import { Injectable } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import { CVDocument, CVData } from './templates/cv-document';
import { CoverLetterDocument, CoverLetterData } from './templates/cover-letter-document';

// The layout's own fit heuristic is a character-count estimate, not a real
// measurement — it can under-shrink (e.g. a user-chosen font size pushing a
// dense CV just past one page). Count actual PDF page objects in the
// rendered output so we can catch that instead of trusting the estimate.
function countPdfPages(buffer: Buffer): number {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches?.length || 1;
}

const MIN_FONT_SIZE = 7;
const SHRINK_FACTOR = 0.92;
const MAX_SHRINK_ATTEMPTS = 8;

@Injectable()
export class PdfService {
  async generateCVPdf(cv: CVData): Promise<Buffer> {
    let workingCv = cv;
    let buffer = await renderToBuffer(CVDocument({ cv: workingCv }));

    for (let attempt = 0; attempt < MAX_SHRINK_ATTEMPTS && countPdfPages(buffer) > 1; attempt++) {
      const currentFontSize = workingCv.options?.fontSize || 11;
      const nextFontSize = currentFontSize * SHRINK_FACTOR;
      if (nextFontSize < MIN_FONT_SIZE) break;

      workingCv = { ...workingCv, options: { ...workingCv.options, fontSize: nextFontSize } };
      buffer = await renderToBuffer(CVDocument({ cv: workingCv }));
    }

    return buffer;
  }

  async generateCoverLetterPdf(letter: CoverLetterData): Promise<Buffer> {
    return renderToBuffer(CoverLetterDocument({ letter }));
  }
}
