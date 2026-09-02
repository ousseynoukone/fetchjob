import { IsString, IsEmail, IsOptional, IsArray, IsObject } from 'class-validator';

export class UpdateCvDto {
  @IsString()
  @IsOptional()
  fullName?: string;

  @IsString()
  @IsOptional()
  headline?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsString()
  @IsOptional()
  phone?: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsString()
  @IsOptional()
  summary?: string;

  @IsString()
  @IsOptional()
  photo?: string;

  @IsArray()
  @IsOptional()
  links?: any[];

  @IsArray()
  @IsOptional()
  skillGroups?: any[];

  @IsArray()
  @IsOptional()
  experiences?: any[];

  @IsArray()
  @IsOptional()
  projects?: any[];

  @IsArray()
  @IsOptional()
  education?: any[];

  @IsArray()
  @IsOptional()
  certifications?: any[];

  @IsArray()
  @IsOptional()
  languages?: any[];

  @IsArray()
  @IsOptional()
  interests?: string[];

  @IsString()
  @IsOptional()
  githubUsername?: string;

  @IsString()
  @IsOptional()
  additionalContext?: string;

  @IsObject()
  @IsOptional()
  options?: {
    fontSize?: number;
    compact?: boolean;
    template?: string;
  };
}
