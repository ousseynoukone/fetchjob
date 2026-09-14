import { IsIn, IsNotEmpty, IsOptional, IsString } from 'class-validator';

export const SUPPORTED_PLATFORMS = ['linkedin', 'indeed', 'france_travail', 'hellowork'] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export class UpsertCredentialDto {
  @IsIn(SUPPORTED_PLATFORMS)
  platform!: SupportedPlatform;

  @IsString()
  @IsNotEmpty()
  email!: string;

  @IsString()
  @IsOptional()
  password?: string;

  @IsString()
  @IsOptional()
  sessionState?: string;
}
