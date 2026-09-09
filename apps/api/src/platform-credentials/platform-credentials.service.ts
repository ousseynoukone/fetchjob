import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { LocalUserService } from '../common/local-user.service';
import { EmailService } from '../email/email.service';
import { SUPPORTED_PLATFORMS, SupportedPlatform } from './dto/upsert-credential.dto';

export interface PlatformCredentialStatus {
  platform: SupportedPlatform;
  configured: boolean;
  email: string | null; // masked, e.g. "j***@example.com" — never the raw value
  lastLoginAt: Date | null;
  lastLoginError: string | null;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, 1) || '*';
  return `${visible}***@${domain}`;
}

// Internal shape handed to the browser-automation layer. No password is
// ever stored — the session is established once by the user logging in
// manually (see scripts/establish-session.js) and reused from here on.
export interface DecryptedCredential {
  email: string;
  sessionState: string | null;
}

@Injectable()
export class PlatformCredentialsService {
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private localUser: LocalUserService,
    private email: EmailService,
  ) {}

  async listStatus(): Promise<PlatformCredentialStatus[]> {
    const userId = await this.localUser.getDefaultUserId();
    const rows = await this.prisma.platformCredential.findMany({ where: { userId } });
    const byPlatform = new Map(rows.map((r) => [r.platform, r]));

    return SUPPORTED_PLATFORMS.map((platform) => {
      const row = byPlatform.get(platform);
      if (!row) {
        return { platform, configured: false, email: null, lastLoginAt: null, lastLoginError: null };
      }
      return {
        platform,
        configured: !!row.sessionStateEncrypted,
        email: maskEmail(this.crypto.decrypt(row.emailEncrypted)),
        lastLoginAt: row.lastLoginAt,
        lastLoginError: row.lastLoginError,
      };
    });
  }

  async remove(platform: SupportedPlatform) {
    const userId = await this.localUser.getDefaultUserId();
    await this.prisma.platformCredential.deleteMany({ where: { userId, platform } });
    return this.listStatus();
  }

  // For internal use by the auto-apply browser automation only.
  async getDecrypted(userId: string, platform: SupportedPlatform): Promise<DecryptedCredential> {
    const row = await this.prisma.platformCredential.findUnique({
      where: { userId_platform: { userId, platform } },
    });
    if (!row) {
      throw new NotFoundException(`Aucune session enregistrée pour ${platform}`);
    }

    return {
      email: this.crypto.decrypt(row.emailEncrypted),
      sessionState: row.sessionStateEncrypted ? this.crypto.decrypt(row.sessionStateEncrypted) : null,
    };
  }

  async saveSessionState(userId: string, platform: SupportedPlatform, sessionState: string) {
    await this.prisma.platformCredential.update({
      where: { userId_platform: { userId, platform } },
      data: { sessionStateEncrypted: this.crypto.encrypt(sessionState), lastLoginAt: new Date(), lastLoginError: null },
    });
  }

  // Called when an applier finds itself back at a login wall with no
  // working session — emails once per occurrence (auto-apply runs at most
  // once a day in practice, so this doesn't spam) rather than silently
  // leaving every candidature on that platform stuck in `needs_review`.
  async recordSessionExpired(userId: string, platform: SupportedPlatform) {
    await this.prisma.platformCredential.update({
      where: { userId_platform: { userId, platform } },
      data: { lastLoginError: 'Session expirée', sessionStateEncrypted: null },
    });

    await this.email.send(
      `Session ${platform} expirée`,
      `<p>La session ${platform} utilisée par l'auto-apply a expiré.</p>` +
        `<p>Relancez <code>npm run establish-session -- ${platform} votre@email.com</code> depuis votre machine pour la rétablir.</p>`,
    );
  }
}
