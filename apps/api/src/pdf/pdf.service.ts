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
// illegible.
const MIN_SCALE_OF_ORIGINAL_WHEN_TWO_PAGE = 0.6;
// The auto-shrink-to-fit-one-page path below only ever runs for a CV that
// has never had a font size set at all (the true system default — nobody
// has opened the "Taille de police" field). Confirmed live against a real
// user's CV (3 jobs, 4 bullets each — not an extreme case) that the old
// floor of 6pt let this path shrink all the way down to ~9pt, well past
// legible; raised to match BASE_FONT_SIZE (cv-document.tsx), the size that
// field's own comment says a normal real-world CV should look like. If
// even this floor can't make a page budget, spill to an extra page instead
// of shrinking further — see the fallback at the end of the search below.
const ABSOLUTE_MIN_FONT_SIZE_ONE_PAGE = 9;
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
// For an explicitly chosen font size, only ever nudge it down by this much
// to reclaim a one-page layout. Confirmed live: the exact chosen size can
// land a hair past the page boundary (e.g. fontSize 9 landed exactly on
// "2 pages, second one empty" for a real CV) — purely a layout rounding
// artifact, not something the user asked for. This band is tight enough to
// clean that up invisibly without reintroducing the old bug it was tuned
// to avoid (a chosen size like 20 getting silently crushed down to ~11).
const EXPLICIT_SIZE_CLEANUP_RATIO = 0.9;

@Injectable()
export class PdfService {
  async generateCVPdf(cv: CVData): Promise<Buffer> {
    const originalFontSize = cv.options?.fontSize || 11;
    const renderAt = (fontSize: number) =>
      renderToBuffer(CVDocument({ cv: { ...cv, options: { ...cv.options, fontSize } } }));

    const buffer = await renderAt(originalFontSize);

    // Once a font size has actually been set (the builder's "Taille de
    // police" field has a real value once a CV has been through it), that's
    // a deliberate, visible choice — render it (at most a hair smaller, see
    // below) rather than silently crushing it down to whatever fits.
    // Confirmed live: without this, picking 20 could still come out shrunk
    // to fit one page, with nothing telling the user their choice was
    // overridden. Letting the CV run to an extra page at the chosen size is
    // more honest than quietly ignoring the size altogether.
    if (cv.options?.fontSize != null) {
      if (countPdfPages(buffer) <= 1) return buffer;

      let low = originalFontSize * EXPLICIT_SIZE_CLEANUP_RATIO;
      let high = originalFontSize;
      let cleanedUp: Buffer | null = null;
      for (let attempt = 0; attempt < MAX_SEARCH_ATTEMPTS && high - low > CONVERGED_THRESHOLD_PT; attempt++) {
        const mid = (low + high) / 2;
        const attemptBuffer = await renderAt(mid);
        if (countPdfPages(attemptBuffer) <= 1) {
          cleanedUp = attemptBuffer;
          low = mid;
        } else {
          high = mid;
        }
      }
      // If a near-invisible reduction can't reclaim one page, the content
      // genuinely doesn't fit — render at the exact size requested and let
      // it spill for real, rather than pretend a bigger compromise is fine.
      return cleanedUp ?? buffer;
    }

    // True system default (nobody has ever set a font size) — auto-shrink
    // for compactness. "twoPage" only raises the page budget this search
    // targets — it never pads or forces a second page.
    const twoPage = !!cv.options?.twoPage;
    const maxPages = twoPage ? 2 : 1;
    if (countPdfPages(buffer) <= maxPages) return buffer;

    const floor = twoPage ? originalFontSize * MIN_SCALE_OF_ORIGINAL_WHEN_TWO_PAGE : ABSOLUTE_MIN_FONT_SIZE_ONE_PAGE;
    let low = floor;
    let high = originalFontSize;
    let bestBuffer: Buffer | null = null;

    for (let attempt = 0; attempt < MAX_SEARCH_ATTEMPTS && high - low > CONVERGED_THRESHOLD_PT; attempt++) {
      const mid = (low + high) / 2;
      const attemptBuffer = await renderAt(mid);
      if (countPdfPages(attemptBuffer) <= maxPages) {
        bestBuffer = attemptBuffer;
        low = mid; // this size fits — see if a bigger one still does too
      } else {
        high = mid; // still overflowing — needs to shrink further
      }
    }

    // Nothing between the floor and the default ever fit the page budget —
    // render at the floor and accept the extra page that produces, rather
    // than shrinking text past the legible floor to force it to fit.
    return bestBuffer ?? (await renderAt(floor));
  }

  async generateCoverLetterPdf(letter: CoverLetterData): Promise<Buffer> {
    return renderToBuffer(CoverLetterDocument({ letter }));
  }
}
