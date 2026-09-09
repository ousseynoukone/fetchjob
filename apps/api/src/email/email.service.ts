import { Injectable, Logger } from '@nestjs/common';
import * as nodemailer from 'nodemailer';
import { SettingsService } from '../common/settings.service';

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
}
