import { IsIn, IsOptional, IsString } from 'class-validator';

export const SUPPORTED_PLATFORMS = ['linkedin', 'indeed', 'france_travail', 'hellowork'] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export class UpsertCredentialDto {
  @IsIn(SUPPORTED_PLATFORMS)
  platform!: SupportedPlatform;

  // Confirmed live: a cookie-only session (pasted storageState JSON, no
  // password) never actually needs an email -- the session itself is what
  // authenticates, the email is only ever a display label. Requiring it
  // anyway blocked saving a perfectly valid session just because the field
  // was left blank.
  @IsString()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  @IsOptional()
  sessionState?: string;
}
