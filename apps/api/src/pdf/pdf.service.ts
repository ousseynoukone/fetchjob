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

// The legible floor — never auto-fit below this even if content is so long
// nothing else fits one page (spill to an extra page instead, see below).
const MIN_FONT_SIZE = 9;
// The auto-fit ceiling for a normal one-page CV. Confirmed live: a short
// CV (e.g. one job, a handful of bullets) rendered at the stored default
// (whatever the "Taille de police" field happened to hold — every real CV
// has a concrete number here, never actually null, so a since-removed
// "only shrink, never grow" branch for an explicit size was silently the
// ONLY path every real user ever took) left a large blank strip at the
// bottom of the page instead of using it — there was no code path that
// ever revisited a too-small stored size upward. This cap is how large a
// CV can get before it starts looking oversized/unprofessional rather than
// genuinely filling the page.
const MAX_AUTO_FONT_SIZE = 15;
// Binary search over font size, not a fixed-percentage step loop: the old
// approach (repeatedly cut the size by 8% and stop at the first size that
// happened to fit) could overshoot well past the true fitting size —
// confirmed live, a user-chosen 20pt CV rendered with visibly tiny text and
// wasted blank space at the bottom of the page, because it never checked
// whether a size between "still overflowing" and "first size that fit"
// would also have fit. This converges on the largest size that actually
// fits within a handful of renders, searching both directions from
// whatever's stored (shrinking an overflowing size down, or — the actual
// reported bug — growing a too-small one up to use the empty page below it).
const MAX_SEARCH_ATTEMPTS = 8;
const CONVERGED_THRESHOLD_PT = 0.2;

@Injectable()
export class PdfService {
  async generateCVPdf(cv: CVData): Promise<Buffer> {
    const renderAt = (fontSize: number) =>
      renderToBuffer(CVDocument({ cv: { ...cv, options: { ...cv.options, fontSize } } }));

    // "twoPage" only raises the page budget this search targets — it never
    // pads or forces a second page.
    const twoPage = !!cv.options?.twoPage;
    const maxPages = twoPage ? 2 : 1;

    // A user who deliberately picks a size bigger than the auto-fit ceiling
    // (wanting unmistakably large text, even at the cost of a second page)
    // still gets that choice honored — auto-fit only ever grows a stored
    // size UP TO this ceiling, it never shrinks a deliberately larger pick
    // down to fit, same as before.
    const requestedSize = cv.options?.fontSize;
    const ceiling = requestedSize && requestedSize > MAX_AUTO_FONT_SIZE ? requestedSize : MAX_AUTO_FONT_SIZE;

    let low = MIN_FONT_SIZE;
    let high = ceiling;
    let bestBuffer: Buffer | null = null;
    let bestSize = MIN_FONT_SIZE;

    for (let attempt = 0; attempt < MAX_SEARCH_ATTEMPTS && high - low > CONVERGED_THRESHOLD_PT; attempt++) {
      const mid = (low + high) / 2;
      const attemptBuffer = await renderAt(mid);
      if (countPdfPages(attemptBuffer) <= maxPages) {
        bestBuffer = attemptBuffer;
        bestSize = mid;
        low = mid; // this size fits — see if a bigger one still does too
      } else {
        high = mid; // overflowing — needs to shrink further
      }
    }

    // Nothing between the floor and the ceiling ever fit the page budget —
    // the content is long enough that even the legible floor spills over.
    // Render at the floor and accept the extra page that produces, rather
    // than shrinking text past the legible floor to force it to fit.
    if (!bestBuffer) return renderAt(MIN_FONT_SIZE);

    // A deliberate choice meaningfully bigger than what auto-fit converged
    // to still wins, even past one page — confirmed live this needs a real
    // margin, not a bare `>`: comparing directly against the search's own
    // result is noisy (11 requested vs. an actually-fitting 10.875 found by
    // the binary search differ by 0.125pt purely from where the search
    // happened to land, not a real choice to go bigger) and wrongly
    // overrode a fitting layout with an overflowing one. Below this margin,
    // auto-fit wins and grows the page to fill it — that's the actual fix
    // for the original "tiny text, blank page" bug and has to keep working
    // for every normal case; only a genuinely bigger pick should bypass it.
    const MEANINGFUL_MARGIN_PT = 0.5;
    if (requestedSize && requestedSize > bestSize + MEANINGFUL_MARGIN_PT) {
      return renderAt(requestedSize);
    }

    return bestBuffer;
  }

  async generateCoverLetterPdf(letter: CoverLetterData): Promise<Buffer> {
    return renderToBuffer(CoverLetterDocument({ letter }));
  }
}
