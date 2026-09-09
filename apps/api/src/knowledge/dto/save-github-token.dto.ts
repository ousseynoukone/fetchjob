import { IsOptional, IsString, MinLength } from 'class-validator';

export class SaveGithubTokenDto {
  @IsString()
  @MinLength(1)
  token!: string;

  @IsString()
  @IsOptional()
  username?: string;
}
