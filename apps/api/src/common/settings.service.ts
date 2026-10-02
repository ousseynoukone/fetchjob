import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { LocalUserService } from './local-user.service';
import { SUPPORTED_PLATFORMS } from '../platform-credentials/dto/upsert-credential.dto';

export interface SettingsFields {
  deepseekApiKey?: string;
  franceTravailClientId?: string;
  franceTravailClientSecret?: string;
  adzunaAppId?: string;
  adzunaApiKey?: string;
  smtpHost?: string;
  smtpPort?: string;
  smtpUsername?: string;
  smtpPassword?: string;
  notificationEmail?: string;
  digestIntervalHours?: string;
  autoApplyMaxAiCalls?: string;
  responseCheckIntervalHours?: string;
  platformStatusCheckIntervalHours?: string;
}

const FIELD_TO_ENV_FALLBACK: Record<keyof SettingsFields, string> = {
  deepseekApiKey: 'DEEPSEEK_API_KEY',
  franceTravailClientId: 'FRANCE_TRAVAIL_CLIENT_ID',
  franceTravailClientSecret: 'FRANCE_TRAVAIL_CLIENT_SECRET',
  adzunaAppId: 'ADZUNA_APP_ID',
  adzunaApiKey: 'ADZUNA_API_KEY',
  smtpHost: 'SMTP_HOST',
  smtpPort: 'SMTP_PORT',
  smtpUsername: 'SMTP_USERNAME',
  smtpPassword: 'SMTP_PASSWORD',
  notificationEmail: 'NOTIFICATION_EMAIL',
  digestIntervalHours: 'DIGEST_INTERVAL_HOURS',
  autoApplyMaxAiCalls: 'AUTO_APPLY_MAX_AI_CALLS',
  responseCheckIntervalHours: 'RESPONSE_CHECK_INTERVAL_HOURS',
  platformStatusCheckIntervalHours: 'PLATFORM_STATUS_CHECK_INTERVAL_HOURS',
};

@Injectable()
export class SettingsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
    private localUser: LocalUserService,
  ) {}

  private async getRow() {
    const existing = await this.prisma.settings.findFirst();
    if (existing) return existing;
    return this.prisma.settings.create({ data: {} });
  }

  // DB value wins when set; otherwise falls back to the matching env var
  // (so .env.local keeps working for anyone who prefers editing files).
  async get(field: keyof SettingsFields): Promise<string | undefined> {
    const row = await this.getRow();
    const dbValue = row[field] as string | null;
    if (dbValue) return dbValue;
    return this.config.get(FIELD_TO_ENV_FALLBACK[field]) || undefined;
  }

  // Whether each field has a real value (DB or env), without exposing secrets.
  async status(): Promise<Record<keyof SettingsFields, boolean>> {
    const row = await this.getRow();
    const fields = Object.keys(FIELD_TO_ENV_FALLBACK) as (keyof SettingsFields)[];
    const result = {} as Record<keyof SettingsFields, boolean>;
    for (const field of fields) {
      const dbValue = row[field] as string | null;
      result[field] = !!(dbValue || this.config.get(FIELD_TO_ENV_FALLBACK[field]));
    }
    return result;
  }

  // Drives the "missing configuration" nav badge (same shape as the
  // "Mises à jour" unseen count) — combines three cheap reads server-side
  // rather than having the frontend poll three separate stores and
  // duplicate this platform/source mapping itself.
  async getMissingConfigCount(): Promise<number> {
    const userId = await this.localUser.getDefaultUserId();
    const [campaign, credentialRows, settingsStatus] = await Promise.all([
      this.prisma.campaign.findFirst({ where: { userId }, select: { sources: true } }),
      this.prisma.platformCredential.findMany({
        where: { userId },
        select: { platform: true, sessionStateEncrypted: true, emailEncrypted: true },
      }),
      this.status(),
    ]);

    const configuredByPlatform = new Map(
      credentialRows.map((r) => [r.platform, !!(r.sessionStateEncrypted || r.emailEncrypted)] as const),
    );
    const sources = (campaign?.sources as string[] | undefined) || [];
    const credentialBacked = new Set<string>(SUPPORTED_PLATFORMS);

    let count = 0;
    // A campaign source that actually needs saved credentials but has none —
    // it would silently fail to scrape/apply at run time.
    for (const source of sources) {
      if (credentialBacked.has(source) && !configuredByPlatform.get(source)) count++;
    }
    // Gmail powers both OTP autofill and the email response tracker —
    // flagged regardless of campaign sources since it's never one of them.
    if (!configuredByPlatform.get('gmail')) count++;
    // AI is used everywhere (CV adaptation, cover letters, auto-apply
    // fallback, response matching), so always relevant.
    if (!settingsStatus.deepseekApiKey) count++;
    // France Travail / Adzuna only matter if that source is actually selected.
    if (sources.includes('france_travail') && !(settingsStatus.franceTravailClientId && settingsStatus.franceTravailClientSecret)) {
      count++;
    }
    if (sources.includes('adzuna') && !(settingsStatus.adzunaAppId && settingsStatus.adzunaApiKey)) {
      count++;
    }

    return count;
  }

  // Only overwrites fields that were actually sent with a non-empty value —
  // an empty/omitted field leaves the existing stored value untouched.
  async update(dto: SettingsFields) {
    const row = await this.getRow();
    const data: Record<string, string> = {};
    for (const [key, value] of Object.entries(dto)) {
      if (typeof value === 'string' && value.trim()) {
        data[key] = value.trim();
      }
    }

    await this.prisma.settings.update({ where: { id: row.id }, data });
    return this.status();
  }

  // Internal bookkeeping for DigestService — never shown or edited in the
  // Paramètres UI, so it doesn't fit the SettingsFields/env-fallback shape
  // above (which is specifically for user-configurable values).
  async getLastDigestSentAt(): Promise<Date | null> {
    const row = await this.getRow();
    return row.lastDigestSentAt;
  }

  async setLastDigestSentAt(date: Date): Promise<void> {
    const row = await this.getRow();
    await this.prisma.settings.update({ where: { id: row.id }, data: { lastDigestSentAt: date } });
  }

  // Same shape as the pair above, for ApplicationResponseTrackerService.
  async getLastResponseCheckAt(): Promise<Date | null> {
    const row = await this.getRow();
    return row.lastResponseCheckAt;
  }

  async setLastResponseCheckAt(date: Date): Promise<void> {
    const row = await this.getRow();
    await this.prisma.settings.update({ where: { id: row.id }, data: { lastResponseCheckAt: date } });
  }

  // Same shape as the pair above, for PlatformStatusCheckerService.
  async getLastPlatformStatusCheckAt(): Promise<Date | null> {
    const row = await this.getRow();
    return row.lastPlatformStatusCheckAt;
  }

  async setLastPlatformStatusCheckAt(date: Date): Promise<void> {
    const row = await this.getRow();
    await this.prisma.settings.update({ where: { id: row.id }, data: { lastPlatformStatusCheckAt: date } });
  }
}
