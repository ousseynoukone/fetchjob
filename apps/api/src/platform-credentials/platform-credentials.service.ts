import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { CryptoService } from '../common/crypto.service';
import { LocalUserService } from '../common/local-user.service';
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

// Internal shape handed to the browser-automation layer — the only place
// that ever sees a decrypted password. Never returned from a controller.
export interface DecryptedCredential {
  email: string;
  password: string;
  sessionState: string | null;
}

@Injectable()
export class PlatformCredentialsService {
  constructor(
    private prisma: PrismaService,
    private crypto: CryptoService,
    private localUser: LocalUserService,
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
        configured: true,
        email: maskEmail(this.crypto.decrypt(row.emailEncrypted)),
        lastLoginAt: row.lastLoginAt,
        lastLoginError: row.lastLoginError,
      };
    });
  }

  async upsert(platform: SupportedPlatform, email: string, password: string) {
    const userId = await this.localUser.getDefaultUserId();

    await this.prisma.platformCredential.upsert({
      where: { userId_platform: { userId, platform } },
      update: {
        emailEncrypted: this.crypto.encrypt(email),
        passwordEncrypted: this.crypto.encrypt(password),
        // Credentials changed — any saved session is for the old account/password.
        sessionStateEncrypted: null,
        lastLoginError: null,
      },
      create: {
        userId,
        platform,
        emailEncrypted: this.crypto.encrypt(email),
        passwordEncrypted: this.crypto.encrypt(password),
      },
    });

    return this.listStatus();
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
      throw new NotFoundException(`Aucun identifiant enregistré pour ${platform}`);
    }

    return {
      email: this.crypto.decrypt(row.emailEncrypted),
      password: this.crypto.decrypt(row.passwordEncrypted),
      sessionState: row.sessionStateEncrypted ? this.crypto.decrypt(row.sessionStateEncrypted) : null,
    };
  }

  async saveSessionState(userId: string, platform: SupportedPlatform, sessionState: string) {
    await this.prisma.platformCredential.update({
      where: { userId_platform: { userId, platform } },
      data: { sessionStateEncrypted: this.crypto.encrypt(sessionState), lastLoginAt: new Date(), lastLoginError: null },
    });
  }

  async recordLoginError(userId: string, platform: SupportedPlatform, message: string) {
    await this.prisma.platformCredential.update({
      where: { userId_platform: { userId, platform } },
      data: { lastLoginError: message },
    });
  }
}
