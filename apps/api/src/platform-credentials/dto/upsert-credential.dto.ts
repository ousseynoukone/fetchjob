import { IsEmail, IsIn, IsString, MinLength } from 'class-validator';

export const SUPPORTED_PLATFORMS = ['linkedin', 'indeed', 'france_travail', 'hellowork'] as const;
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];

export class UpsertCredentialDto {
  @IsIn(SUPPORTED_PLATFORMS)
  platform!: SupportedPlatform;

  @IsEmail()
  email!: string;

  @IsString()
  @MinLength(1)
  password!: string;
}
