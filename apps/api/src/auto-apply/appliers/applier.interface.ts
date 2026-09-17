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
  // The filename shown to the platform/recruiter on upload (see
  // ats-common.ts's uploadCv) — derived from the candidate's own name, not
  // the temp file's on-disk name (which is a generic, id-based filename).
  cvFileName: string;
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
  appendLog?: (message: string) => Promise<void>;
  credential?: { email: string; password?: string | null } | null;
  onSessionUpdated?: (newSessionState: string) => Promise<void>;
  // Cap on AI-assisted form-filling fallback calls for this single attempt
  // (see ai-form-loop.ts) — resolved once per run from the "autoApplyMaxAiCalls"
  // setting (Paramètres page), not a hardcoded constant, so it's tunable
  // without a code change.
  maxAiCallsPerAttempt: number;
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
  // Set when this applier discovered, mid-flow, that the real application
  // happens somewhere else entirely (LinkedIn/Indeed/HelloWork postings
  // with no in-platform apply flow just send the visitor to the employer's
  // own site) — the caller re-routes to whichever applier owns that URL (a
  // known ATS, or the generic fallback) instead of giving up here.
  redirectToExternalUrl?: string;
  // Set when the applier ended up filling/submitting the form on a
  // DIFFERENT page than the one it was handed (e.g. France Travail's native
  // apply link opens its real form in a new tab via `target="_blank"`) --
  // confirmed live: without this, the caller's own post-attempt screenshot
  // and "unanswered field" scan kept running against the original,
  // now-irrelevant tab, showing/reporting whatever was left on it instead
  // of the actual form the attempt succeeded or failed on.
  finalPage?: Page;
}

export interface JobApplier {
  // Credential platform key this applier needs a saved session for (e.g.
  // 'linkedin'), or null if it never logs in (generic/ATS fallback).
  readonly credentialPlatform: string | null;
  apply(page: Page, ctx: ApplyContext): Promise<ApplyResult>;
}
