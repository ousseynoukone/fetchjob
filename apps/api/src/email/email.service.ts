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
      });

      // Gmail (and most providers) reject or silently rewrite a From
      // address that isn't the authenticated account.
      await transporter.sendMail({ from: username, to, subject, html });
    } catch (error: any) {
      this.logger.warn(`Failed to send email alert: ${error.message}`);
    }
  }

  // Periodic summary of every candidature sent since the last one (see
  // DigestService), replacing one email per candidature. No attachments —
  // each entry links to its own detail page on the platform, where the
  // exact CV that was sent and the full offer are already viewable.
  async sendDigestEmail(
    applications: { id: string; jobTitle: string; company: string; jobOfferUrl: string }[],
    needsReviewCount: number,
  ): Promise<void> {
    if (!applications.length) return;

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const rows = applications
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

    const needsReviewLine = needsReviewCount
      ? `<p>${needsReviewCount} candidature(s) supplémentaire(s) à finaliser manuellement (voir l'onglet Candidatures).</p>`
      : '';

    const html = `
      <h2>${applications.length} candidature(s) envoyée(s)</h2>
      <ul style="padding-left:18px">${rows}</ul>
      ${needsReviewLine}
    `;

    await this.send(`Résumé candidatures : ${applications.length} envoyée(s)`, html);
  }
}
