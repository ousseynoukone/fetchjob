import { IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class UpdateCampaignDto {
  @IsString()
  @IsOptional()
  jobTitle?: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsBoolean()
  @IsOptional()
  remote?: boolean;

  @IsArray()
  @IsOptional()
  contractTypes?: string[];

  @IsArray()
  @IsOptional()
  keywords?: string[];

  @IsArray()
  @IsOptional()
  excludeKeywords?: string[];

  @IsInt()
  @Min(0)
  @Max(60)
  @IsOptional()
  maxAgeMonths?: number;

  @IsInt()
  @Min(1)
  @Max(100)
  @IsOptional()
  maxApplicationsPerDay?: number;

  @IsInt()
  @Min(0)
  @Max(100)
  @IsOptional()
  minMatchScore?: number;

  @IsIn(['prepare_only', 'auto_apply'])
  @IsOptional()
  actionMode?: string;

  @IsArray()
  @IsOptional()
  sources?: string[];
}
