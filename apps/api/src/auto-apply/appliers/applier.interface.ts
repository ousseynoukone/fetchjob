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
  // Present only when this applier's `credentialPlatform` has a saved
  // PlatformCredential — the applier is responsible for detecting whether
  // it's already logged in (session reused) before attempting to fill this.
  credential: { email: string; password: string } | null;
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
}

export interface JobApplier {
  // Credential platform key this applier needs from PlatformCredential
  // (e.g. 'linkedin'), or null if it never logs in (generic fallback).
  readonly credentialPlatform: string | null;
  apply(page: Page, ctx: ApplyContext): Promise<ApplyResult>;
}
