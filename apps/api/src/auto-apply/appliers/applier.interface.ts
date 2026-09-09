import type { Page } from 'playwright';
import type { CVData } from '../../pdf/templates/cv-document';
import type { DetectedField } from './form-fields';

export interface ApplyContext {
  application: {
    id: string;
    jobTitle: string;
    company: string;
    sourceUrl: string;
  };
  cv: CVData;
  cvPdfPath: string;
  coverLetter: string | null;
  // Custom/screening questions answered once before (see
  // CustomQuestionsService), keyed by normalized label text — appliers call
  // `fillKnownFields(page, knownAnswers)` once the form is visible so a
  // known answer is filled instead of blocking the candidature again.
  knownAnswers: Map<string, string>;
  // Called when a validation error blocks progress — appliers pass the
  // still-unanswered fields found via `scanInvalidFields(page)` so they get
  // stored (and the user notified) instead of just failing silently again
  // next time the same offer/question comes up.
  reportUnknownFields: (fields: DetectedField[]) => Promise<void>;
}

export interface ApplyResult {
  success: boolean;
  // Reason the candidature could not be completed (CAPTCHA, 2FA, form not
  // recognized, external redirect...) — always set when success is false.
  note?: string;
  // Set when the applier found itself back at a login wall with no working
  // session — triggers an email alert so the user knows to re-run
  // `npm run establish-session -- <platform> ...` rather than silently
  // leaving every candidature on that platform stuck in `needs_review`.
  sessionExpired?: boolean;
}

export interface JobApplier {
  // Credential platform key this applier needs a saved session for (e.g.
  // 'linkedin'), or null if it never logs in (generic/ATS fallback).
  readonly credentialPlatform: string | null;
  apply(page: Page, ctx: ApplyContext): Promise<ApplyResult>;
}
