import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from './prisma.service';

export interface SettingsFields {
  deepseekApiKey?: string;
  franceTravailClientId?: string;
  franceTravailClientSecret?: string;
  adzunaAppId?: string;
  adzunaApiKey?: string;
}

const FIELD_TO_ENV_FALLBACK: Record<keyof SettingsFields, string> = {
  deepseekApiKey: 'DEEPSEEK_API_KEY',
  franceTravailClientId: 'FRANCE_TRAVAIL_CLIENT_ID',
  franceTravailClientSecret: 'FRANCE_TRAVAIL_CLIENT_SECRET',
  adzunaAppId: 'ADZUNA_APP_ID',
  adzunaApiKey: 'ADZUNA_API_KEY',
};

@Injectable()
export class SettingsService {
  constructor(
    private prisma: PrismaService,
    private config: ConfigService,
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
}
