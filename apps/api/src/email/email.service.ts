import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { SettingsService } from '../common/settings.service';

function escapeHtml(text: string): string {
  return (text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

@Injectable()
export class EmailService {
  private readonly logger = new Logger(EmailService.name);

  constructor(private settings: SettingsService) {}

  // Silently no-ops when SMTP isn't fully configured — email alerts are a
  // convenience on top of the in-app "Questions" list, never a requirement
  // for auto-apply itself to keep working.
  async send(subject: string, html: string): Promise<void> {
    const [host, port, username, password, to] = await Promise.all([
      this.settings.get('smtpHost'),
      this.settings.get('smtpPort'),
      this.settings.get('smtpUsername'),
      this.settings.get('smtpPassword'),
      this.settings.get('notificationEmail'),
    ]);
    if (!host || !port || !username || !password || !to) return;

    try {
      const portNumber = Number(port);
      const transporter = nodemailer.createTransport({
        host,
        port: portNumber,
        secure: portNumber === 465,
        auth: { user: username, pass: password },
        // Nodemailer's defaults are 2 minutes to connect and 10 minutes per
        // socket. Confirmed live: a slow/blocked SMTP path from the container
        // stalled the session-health sweep ~7 minutes between two platforms,
        // because the "session expired" alert is sent from inside it. A
        // notification email is never worth minutes of blocked work.
        connectionTimeout: 10_000,
        greetingTimeout: 10_000,
        socketTimeout: 20_000,
      });

      // Gmail (and most providers) reject or silently rewrite a From
      // address that isn't the authenticated account.
      await transporter.sendMail({ from: username, to, subject, html });
    } catch (error: any) {
      this.logger.warn(`Failed to send email alert: ${error.message}`);
    }
  }

  // The ONE email this app sends (see DigestService): a periodic summary of
  // everything that happened since the last one. Every notification that
  // used to be its own email -- one per candidature, one per newly captured
  // form question, one per expired session (re-sent on every 20-minute
  // health check for as long as it stayed expired) -- is a section in here
  // instead, so the person gets at most one message per interval, and none
  // at all when there's nothing to say. No attachments — each candidature
  // links to its own detail page, where the exact CV sent and the full
  // offer are already viewable.
  async sendDigestEmail(digest: {
    sent: { id: string; jobTitle: string; company: string; jobOfferUrl: string }[];
    needsReviewCount: number;
    newQuestions: { platform: string; questionText: string }[];
    expiredPlatforms: string[];
  }): Promise<void> {
    const { sent, needsReviewCount, newQuestions, expiredPlatforms } = digest;
    if (!sent.length && !needsReviewCount && !newQuestions.length && !expiredPlatforms.length) return;

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const sections: string[] = [];
    const subjectParts: string[] = [];

    if (expiredPlatforms.length) {
      subjectParts.push(`${expiredPlatforms.length} session(s) à reconnecter`);
      sections.push(`
        <h2>Session(s) à reconnecter</h2>
        <p>L'auto-apply ne peut plus utiliser : <strong>${expiredPlatforms.map(escapeHtml).join(', ')}</strong>.</p>
        <p>Ouvrez <a href="${frontendUrl}/parametres">Comptes</a> et cliquez sur « Ouvrir la session » pour chacune.</p>
      `);
    }

    if (sent.length) {
      subjectParts.push(`${sent.length} envoyée(s)`);
      const rows = sent
        .map((application) => {
          const detailUrl = `${frontendUrl}/candidatures/${application.id}`;
          return `
            <li style="margin-bottom:12px">
              <strong>${escapeHtml(application.jobTitle)}</strong> chez ${escapeHtml(application.company)}<br/>
              <a href="${application.jobOfferUrl}">Voir l'offre</a> ·
              <a href="${detailUrl}">Voir les détails et le CV envoyé</a>
            </li>
          `;
        })
        .join('');
      sections.push(`<h2>${sent.length} candidature(s) envoyée(s)</h2><ul style="padding-left:18px">${rows}</ul>`);
    }

    if (needsReviewCount) {
      subjectParts.push(`${needsReviewCount} à vérifier`);
      sections.push(
        `<p>${needsReviewCount} candidature(s) à finaliser manuellement (voir <a href="${frontendUrl}/candidatures?tab=needs_review">l'onglet Candidatures</a>).</p>`,
      );
    }

    if (newQuestions.length) {
      subjectParts.push(`${newQuestions.length} question(s) à répondre`);
      const items = newQuestions
        .map((q) => `<li>[${escapeHtml(q.platform)}] ${escapeHtml(q.questionText)}</li>`)
        .join('');
      sections.push(`
        <h2>${newQuestions.length} nouvelle(s) question(s) à répondre</h2>
        <p>Ces questions ont bloqué des candidatures. Répondez-y une fois dans <a href="${frontendUrl}/questions">Questions</a> pour qu'elles soient remplies automatiquement la prochaine fois.</p>
        <ul>${items}</ul>
      `);
    }

    await this.send(`FindUrJob — ${subjectParts.join(', ')}`, sections.join('\n'));
  }
}
