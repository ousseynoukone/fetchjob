import { Injectable } from '@nestjs/common';
import { renderToBuffer } from '@react-pdf/renderer';
import { CVDocument, CVData } from './templates/cv-document';
import { CoverLetterDocument, CoverLetterData } from './templates/cover-letter-document';

// Count actual PDF page objects in the rendered output — a real measurement
// of whether a given font size fits, rather than guessing from content
// length beforehand.
function countPdfPages(buffer: Buffer): number {
  const matches = buffer.toString('latin1').match(/\/Type\s*\/Page[^s]/g);
  return matches?.length || 1;
}

// When the user has opted into a second page, never shrink their chosen
// size by more than this — past this point the CV should spill onto that
// second page (which is exactly what they asked for) rather than become
// illegible. Without that opt-in, one page is a HARD requirement — the CV
// builder's own promise, and confirmed directly by the user comparing
// output against their own real reference CV, which fits one page: an
// unrequested second page is not an acceptable trade for a bigger font, no
// matter how dense the content. (A higher floor here was tried briefly to
// improve readability automatically, but it made the one-page case spill
// onto an unwanted second page for a normal CV — reverted.) This floor
// only needs to be low enough that a real CV's content can always be made
// to fit; DEFAULT_FONT_SIZE/BASE_FONT_SIZE (cv-document.tsx) already
// handles making the common case look good without ever needing to shrink
// this far.
const MIN_SCALE_OF_ORIGINAL_WHEN_TWO_PAGE = 0.6;
const ABSOLUTE_MIN_FONT_SIZE_ONE_PAGE = 6;
// Binary search over font size, not a fixed-percentage shrink loop: the old
// approach (repeatedly cut the size by 8% and stop at the first size that
// happened to fit) could overshoot well past the true fitting size —
// confirmed live, a user-chosen 20pt CV rendered with visibly tiny text and
// wasted blank space at the bottom of the page, because it never checked
// whether a size between "still overflowing" and "first size that fit"
// would also have fit. This converges on the largest size that actually
// fits within a handful of renders.
const MAX_SEARCH_ATTEMPTS = 8;
const CONVERGED_THRESHOLD_PT = 0.2;

@Injectable()
export class PdfService {
  async generateCVPdf(cv: CVData): Promise<Buffer> {
    // "twoPage" only raises the page budget this search targets — it never
    // pads or forces a second page. A short CV still renders on one page; a
    // dense one is allowed to spill onto a second instead of being squeezed
    // to fit a single page.
    const twoPage = !!cv.options?.twoPage;
    const maxPages = twoPage ? 2 : 1;
    const originalFontSize = cv.options?.fontSize || 11;

    const renderAt = (fontSize: number) =>
      renderToBuffer(CVDocument({ cv: { ...cv, options: { ...cv.options, fontSize } } }));

    let buffer = await renderAt(originalFontSize);
    if (countPdfPages(buffer) <= maxPages) return buffer;

    let low = twoPage ? originalFontSize * MIN_SCALE_OF_ORIGINAL_WHEN_TWO_PAGE : ABSOLUTE_MIN_FONT_SIZE_ONE_PAGE;
    let high = originalFontSize;
    let bestBuffer: Buffer | null = null;

    for (let attempt = 0; attempt < MAX_SEARCH_ATTEMPTS && high - low > CONVERGED_THRESHOLD_PT; attempt++) {
      const mid = (low + high) / 2;
      buffer = await renderAt(mid);
      if (countPdfPages(buffer) <= maxPages) {
        bestBuffer = buffer;
        low = mid; // this size fits — see if a bigger one still does too
      } else {
        high = mid; // still overflowing — needs to shrink further
      }
    }

    // If nothing within the floor ever fit, return the last (smallest)
    // attempt rather than the original oversized render — still the best
    // available outcome short of spilling past the page budget.
    return bestBuffer ?? buffer;
  }

  async generateCoverLetterPdf(letter: CoverLetterData): Promise<Buffer> {
    return renderToBuffer(CoverLetterDocument({ letter }));
  }
}
