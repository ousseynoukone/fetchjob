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
  async send(
    subject: string,
    html: string,
    attachments?: { filename: string; content: Buffer }[],
  ): Promise<void> {
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
      await transporter.sendMail({ from: username, to, subject, html, attachments });
    } catch (error: any) {
      this.logger.warn(`Failed to send email alert: ${error.message}`);
    }
  }

  // One email per candidature actually sent (bot or manual "Marquer comme
  // postulée") — the CV attached is the exact PDF that went out, the offer
  // is linked back to its original source, and the button goes straight to
  // this candidature's detail page rather than the general candidatures list.
  async sendApplicationSentEmail(params: {
    applicationId: string;
    jobTitle: string;
    company: string;
    jobOfferUrl: string;
    jobDescription: string;
    cvPdf: Buffer;
  }): Promise<void> {
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const detailUrl = `${frontendUrl}/candidatures/${params.applicationId}`;
    const description = (params.jobDescription || '').trim();
    const excerpt = description.slice(0, 600);

    const html = `
      <h2>Candidature envoyée : ${escapeHtml(params.jobTitle)} chez ${escapeHtml(params.company)}</h2>
      <p><a href="${params.jobOfferUrl}">Voir l'offre originale</a></p>
      <p style="white-space:pre-wrap;color:#444">${escapeHtml(excerpt)}${description.length > excerpt.length ? '…' : ''}</p>
      <p>
        <a href="${detailUrl}" style="display:inline-block;padding:10px 16px;background:#2d5bff;color:#fff;text-decoration:none;border-radius:6px">
          Voir les détails sur la plateforme
        </a>
      </p>
    `;

    const safeFileName = `CV - ${params.jobTitle} - ${params.company}`
      .replace(/[\\/:*?"<>|]/g, '')
      .slice(0, 100);

    await this.send(
      `Candidature envoyée : ${params.jobTitle} chez ${params.company}`,
      html,
      [{ filename: `${safeFileName}.pdf`, content: params.cvPdf }],
    );
  }
}
