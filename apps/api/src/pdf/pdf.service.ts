import { Injectable } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import { CVDocument, CVData, estimateFitScale, getUserScale } from './templates/cv-document';
import { CoverLetterDocument, CoverLetterData } from './templates/cover-letter-document';

// The layout's own fit heuristic is a character-count estimate, not a real
// measurement — it can under-shrink (e.g. a user-chosen font size pushing a
// dense CV just past one page). Count actual PDF page objects in the
// rendered output so we can catch that instead of trusting the estimate.
function countPdfPages(buffer: Buffer): number {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches?.length || 1;
}

// This shrink stacks on top of the fit heuristic already baked into the
// template (estimateFitScale), which can itself go as low as 0.6x. Floor the
// *combined* scale actually applied to text, not the raw fontSize number —
// otherwise a CV that still overflows keeps shrinking past legibility (down
// to a barely-readable ~0.4x) instead of just spilling onto a second page.
const MIN_EFFECTIVE_SCALE = 0.6;
const SHRINK_FACTOR = 0.92;
const MAX_SHRINK_ATTEMPTS = 8;

@Injectable()
export class PdfService {
  async generateCVPdf(cv: CVData): Promise<Buffer> {
    let workingCv = cv;
    let buffer = await renderToBuffer(CVDocument({ cv: workingCv }));

    for (let attempt = 0; attempt < MAX_SHRINK_ATTEMPTS && countPdfPages(buffer) > 1; attempt++) {
      const twoColumn = workingCv.options?.template !== 'ats';
      const effectiveScale = getUserScale(workingCv) * estimateFitScale(workingCv, { twoColumn });
      if (effectiveScale <= MIN_EFFECTIVE_SCALE) break;

      const currentFontSize = workingCv.options?.fontSize || 11;
      const nextFontSize = currentFontSize * SHRINK_FACTOR;
      workingCv = { ...workingCv, options: { ...workingCv.options, fontSize: nextFontSize } };
      buffer = await renderToBuffer(CVDocument({ cv: workingCv }));
    }

    return buffer;
  }

  async generateCoverLetterPdf(letter: CoverLetterData): Promise<Buffer> {
    return renderToBuffer(CoverLetterDocument({ letter }));
  }
}
