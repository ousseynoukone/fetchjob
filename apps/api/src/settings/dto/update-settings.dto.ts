import { IsOptional, IsString } from 'class-validator';

export class UpdateSettingsDto {
  @IsString()
  @IsOptional()
  deepseekApiKey?: string;

  @IsString()
  @IsOptional()
  franceTravailClientId?: string;

  @IsString()
  @IsOptional()
  franceTravailClientSecret?: string;

  @IsString()
  @IsOptional()
  adzunaAppId?: string;

  @IsString()
  @IsOptional()
  adzunaApiKey?: string;

  @IsString()
  @IsOptional()
  smtpHost?: string;

  @IsString()
  @IsOptional()
  smtpPort?: string;

  @IsString()
  @IsOptional()
  smtpUsername?: string;

  @IsString()
  @IsOptional()
  smtpPassword?: string;

  @IsString()
  @IsOptional()
  notificationEmail?: string;
}
