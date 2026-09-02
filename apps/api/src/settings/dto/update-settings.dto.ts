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
}
