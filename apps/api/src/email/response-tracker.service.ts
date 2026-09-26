import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma.service';
import { LocalUserService } from '../common/local-user.service';
import { SettingsService } from '../common/settings.service';
import { GmailOtpService } from '../common/gmail-otp.service';
import { AiService } from '../ai/ai.service';

const DEFAULT_INTERVAL_HOURS = 12;
// How far back the very first scan looks, when there's no lastResponseCheckAt
// yet to start from -- bounds the cost of the first run instead of reading a
// person's entire mailbox history.
const FIRST_SCAN_MAX_DAYS = 45;
// AI-matching cost scales with the email batch size; chunk rather than send
// an unbounded inbox dump in one prompt.
const EMAIL_BATCH_SIZE = 40;

// Filtered out BEFORE ever reaching the AI: pure platform/account plumbing
// (a "bienvenue sur myGrafton" account-creation notice, an email
// verification link, a password reset) carries zero signal about an
// application's outcome, so there's no reason to spend a single token
// classifying it -- confirmed live that these were slipping through
// unfiltered and burning prompt space for nothing. Deliberately narrow: does
// NOT match "accusé de réception de candidature" style confirmations, which
// DO have real value (proof a 'needs_review' row actually got submitted).
const NOISE_SUBJECT_PATTERNS =
  /^(re\s*:\s*)?(bienvenue|welcome)\b|activ(ez|ation) (votre|de) compte|confirmez votre (email|adresse)|v[ée]rifiez votre (email|adresse)|r[ée]initialis(ez|ation)( votre| de)? mot de passe|(se )?d[ée]sabonn|unsubscribe|newsletter/i;

// A second, cheaper filter -- deterministic, no extra AI call -- applied
// AFTER the AI has already matched an email to an application. Confirmed
// live that the vast majority of "update" verdicts were the AI correctly
// reading a plain ATS receipt confirmation ("candidature bien reçue",
// "votre candidature est arrivée chez X", "merci d'avoir postulé",
// "confirmation de votre candidature"...) -- true information, but
// worthless as an "unseen update" once the candidature is ALREADY known
// 'applied': it tells the user nothing they don't already know, and was
// exactly what the user meant by "polluting" the panel with things needing
// no actual review. Kept distinct from NOISE_SUBJECT_PATTERNS on purpose:
// THIS content still matters the first time a 'needs_review' row gets one
// (real proof the submission went through), so it can't be dropped before
// matching -- only suppressed afterward, once we know which application it
// hit and whether that application already had a confirmed status.
const RECEIPT_CONFIRMATION_PATTERNS =
  /candidature\s+(?:(?:a|est)\s+)?(?:bien\s+)?(?:[ée]t[ée]\s+)?(?:re[cç]ue|transmise|arriv[ée]e|envoy[ée]e|spontan[ée]e)|merci\s+(?:de votre|d.avoir postul|pour (?:ta|votre) candidature)|confirmation de (?:votre|ta) candidature|suite [àa] votre candidature|suivi de (?:ta|votre) candidature|candidature\s+(?:pour\s+(?:le poste de|[êe]tre|un poste)|sur\s+(?:l.)?offre|.{0,60}[àa]\s+l.offre)|application received|thank you for (?:your application|applying)/i;

// Scans Gmail for recruiter replies to sent candidatures and updates their
// status automatically -- checked hourly, but only actually scans once
// `responseCheckIntervalHours` have really passed, same "check often, act
// rarely" shape as DigestService.
//
// Also scans 'needs_review' candidatures, not only 'applied': confirmed live
// this same session that several "confirmation non détectée" cases (WTTJ,
// APEC) were real, successful submissions the apply-time heuristic just
// failed to recognize -- a genuine recruiter reply is stronger proof the
// application went through than our own on-page detection, so it's allowed
// to correct that status too.
@Injectable()
export class ApplicationResponseTrackerService {
  private readonly logger = new Logger(ApplicationResponseTrackerService.name);

  constructor(
    private prisma: PrismaService,
    private localUser: LocalUserService,
    private settings: SettingsService,
    private gmailOtp: GmailOtpService,
    private ai: AiService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async checkAndScan() {
    try {
      await this.run();
    } catch (error: any) {
      this.logger.warn(`Response-tracking scan failed: ${error.message}`);
    }
  }

  private async run() {
    const lastCheckedAt = await this.settings.getLastResponseCheckAt();
    const intervalRaw = await this.settings.get('responseCheckIntervalHours');
    const intervalHours = Number(intervalRaw) > 0 ? Number(intervalRaw) : DEFAULT_INTERVAL_HOURS;

    if (lastCheckedAt) {
      const dueAt = new Date(lastCheckedAt.getTime() + intervalHours * 3_600_000);
      if (new Date() < dueAt) return;
    }

    const userId = await this.localUser.getDefaultUserId();

    const open = await this.prisma.application.findMany({
      where: { userId, status: { in: ['applied', 'needs_review'] } },
      select: { id: true, company: true, jobTitle: true, appliedAt: true, createdAt: true, status: true },
    });

    if (!open.length) {
      await this.settings.setLastResponseCheckAt(new Date());
      return;
    }

    // For 'needs_review' rows appliedAt is null (never confirmed sent) --
    // createdAt (when the candidature was first prepared) is the best
    // available stand-in for "earliest a reply could plausibly exist".
    const referenceDates = open.map((a) => a.appliedAt || a.createdAt);
    const since = lastCheckedAt
      ? lastCheckedAt
      : new Date(
          Math.max(
            Math.min(...referenceDates.map((d) => d.getTime())),
            Date.now() - FIRST_SCAN_MAX_DAYS * 86_400_000,
          ),
        );

    const fetched = await this.gmailOtp.searchRecentMessages(userId, since);
    const emails = fetched.filter((e) => !NOISE_SUBJECT_PATTERNS.test(e.subject.trim()));
    if (!emails.length) {
      await this.settings.setLastResponseCheckAt(new Date());
      return;
    }

    this.logger.log(
      `Response-tracking scan: ${emails.length} email(s) since ${since.toISOString()} (${fetched.length - emails.length} filtrés avant l'IA), ${open.length} candidature(s) open.`,
    );

    const applicationsPayload = open.map((a) => ({
      id: a.id,
      company: a.company,
      jobTitle: a.jobTitle,
      appliedAt: (a.appliedAt || a.createdAt).toISOString(),
    }));

    for (let i = 0; i < emails.length; i += EMAIL_BATCH_SIZE) {
      const batch = emails.slice(i, i + EMAIL_BATCH_SIZE);
      const emailsPayload = batch.map((e, idx) => ({
        index: i + idx,
        from: e.from,
        subject: e.subject,
        date: e.date.toISOString(),
        snippet: e.snippet,
      }));
      const emailByIndex = new Map(emailsPayload.map((e) => [e.index, e]));

      const matches = await this.ai.matchApplicationResponses(emailsPayload, applicationsPayload).catch((err) => {
        this.logger.warn(`AI matching failed for batch starting at ${i}: ${err.message}`);
        return [];
      });

      for (const match of matches) {
        const application = open.find((a) => a.id === match.applicationId);
        if (!application) continue;
        const sourceEmail = emailByIndex.get(match.emailIndex);

        // A verdict maps directly to the final status -- rejected/interview/
        // offer are confirmed outcomes regardless of whether the candidature
        // started as 'applied' or 'needs_review' (a reply proves it sent).
        // 'update' (some reply, no clear verdict yet) only promotes a
        // 'needs_review' row to 'applied' for the same reason; it never
        // demotes an already-'applied' one. autoUpdateVerdict is stored
        // separately from `status` and distinguishes THIS case ('confirmed'
        // -- proof of submission, not an outcome) from a genuinely
        // ambiguous reply on an already-'applied' row ('update') -- both
        // used to collapse into the same status='applied' and the same
        // misleading "Réponse reçue" badge, confirmed confusing directly by
        // the user, with no way to check the claim against its source.
        const wasNeedsReview = application.status === 'needs_review';
        const statusUpdate: Record<string, any> = {
          hasUnseenUpdate: true,
          autoUpdateSummary: match.summary || null,
          autoUpdateAt: new Date(),
          autoUpdateSource: 'gmail',
          autoUpdateEvidence: sourceEmail
            ? `De : ${sourceEmail.from}\nObjet : "${sourceEmail.subject}"\nReçu le ${new Date(sourceEmail.date).toLocaleDateString('fr-FR')}\nExtrait cité : "${match.evidence || sourceEmail.snippet.slice(0, 250)}"`
            : null,
        };
        if (match.verdict === 'rejected') {
          statusUpdate.status = 'rejected';
          statusUpdate.rejectedAt = new Date();
          statusUpdate.autoUpdateVerdict = 'rejected';
        } else if (match.verdict === 'interview') {
          statusUpdate.status = 'interview';
          statusUpdate.autoUpdateVerdict = 'interview';
        } else if (match.verdict === 'offer') {
          statusUpdate.status = 'offer';
          statusUpdate.autoUpdateVerdict = 'offer';
        } else if (match.verdict === 'update' && wasNeedsReview) {
          statusUpdate.status = 'applied';
          statusUpdate.autoUpdateVerdict = 'confirmed';
        } else if (match.verdict === 'update' && sourceEmail && RECEIPT_CONFIRMATION_PATTERNS.test(sourceEmail.subject)) {
          // Already 'applied' and this is just the platform's own automated
          // "we got it" receipt -- nothing the user doesn't already know.
          // Recorded nowhere and never flagged: see RECEIPT_CONFIRMATION_PATTERNS.
          continue;
        } else {
          statusUpdate.autoUpdateVerdict = 'update';
        }

        await this.prisma.application.update({ where: { id: application.id }, data: statusUpdate }).catch((err) => {
          this.logger.warn(`Failed to record response for application ${application.id}: ${err.message}`);
        });
      }
    }

    await this.settings.setLastResponseCheckAt(new Date());
  }
}
