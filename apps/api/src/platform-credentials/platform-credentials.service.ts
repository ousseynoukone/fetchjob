import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { LocalUserService } from '../common/local-user.service';
import { EmailService } from '../email/email.service';
import { SUPPORTED_PLATFORMS, SupportedPlatform } from './dto/upsert-credential.dto';

export interface PlatformCredentialStatus {
  platform: SupportedPlatform;
  configured: boolean;
  email: string | null;
  lastLoginAt: Date | null;
  lastLoginError: string | null;
}

function maskEmail(email: string): string {
  const [local, domain] = email.split('@');
  if (!domain) return '***';
  const visible = local.slice(0, 1) || '*';
  return `${visible}***@${domain}`;
}

export interface DecryptedCredential {
  email: string;
  password?: string | null;
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
        configured: !!(row.sessionStateEncrypted || row.emailEncrypted),
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

  async upsert(dto: { platform: SupportedPlatform; email: string; password?: string; sessionState?: string }) {
    const userId = await this.localUser.getDefaultUserId();
    const emailEncrypted = this.crypto.encrypt(dto.email);
    const payload = JSON.stringify({
      password: dto.password ?? null,
      storageState: dto.sessionState ?? null,
    });
    const sessionStateEncrypted = this.crypto.encrypt(payload);

    await this.prisma.platformCredential.upsert({
      where: { userId_platform: { userId, platform: dto.platform } },
      update: {
        emailEncrypted,
        sessionStateEncrypted,
        lastLoginAt: new Date(),
        lastLoginError: null,
      },
      create: {
        userId,
        platform: dto.platform,
        emailEncrypted,
        sessionStateEncrypted,
        lastLoginAt: new Date(),
        lastLoginError: null,
      },
    });

    return this.listStatus();
  }

  async getDecrypted(userId: string, platform: SupportedPlatform): Promise<DecryptedCredential> {
    const row = await this.prisma.platformCredential.findUnique({
      where: { userId_platform: { userId, platform } },
    });
    if (!row) {
      throw new NotFoundException(`Aucune session ou identifiant enregistré pour ${platform}`);
    }

    const email = this.crypto.decrypt(row.emailEncrypted);
    let password: string | null = null;
    let sessionState: string | null = null;

    if (row.sessionStateEncrypted) {
      const raw = this.crypto.decrypt(row.sessionStateEncrypted);
      try {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') {
          if ('password' in parsed || 'storageState' in parsed) {
            password = parsed.password ?? null;
            sessionState = parsed.storageState
              ? typeof parsed.storageState === 'string'
                ? parsed.storageState
                : JSON.stringify(parsed.storageState)
              : null;
          } else {
            sessionState = raw;
          }
        } else {
          sessionState = raw;
        }
      } catch {
        sessionState = raw;
      }
    }

    return { email, password, sessionState };
  }

  async saveSessionState(userId: string, platform: SupportedPlatform, sessionState: string) {
    const existing = await this.prisma.platformCredential.findUnique({
      where: { userId_platform: { userId, platform } },
    });
    let password: string | null = null;
    if (existing?.sessionStateEncrypted) {
      try {
        const parsed = JSON.parse(this.crypto.decrypt(existing.sessionStateEncrypted));
        if (parsed && parsed.password) password = parsed.password;
      } catch {}
    }

    const payload = password
      ? JSON.stringify({ password, storageState: sessionState })
      : sessionState;

    await this.prisma.platformCredential.update({
      where: { userId_platform: { userId, platform } },
      data: { sessionStateEncrypted: this.crypto.encrypt(payload), lastLoginAt: new Date(), lastLoginError: null },
    });
  }

  async recordSessionExpired(userId: string, platform: SupportedPlatform) {
    await this.prisma.platformCredential.update({
      where: { userId_platform: { userId, platform } },
      data: { lastLoginError: 'Session expirée' },
    });

    await this.email.send(
      `Session ${platform} expirée`,
      `<p>La session ${platform} utilisée par l'auto-apply a expiré.</p>` +
        `<p>Renseignez à nouveau votre mot de passe dans Paramètres pour réactiver la connexion automatique.</p>`,
    );
  }
}
