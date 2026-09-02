import { IsOptional, IsString, IsUrl, MinLength } from 'class-validator';

export class AddManualOfferDto {
  @IsString()
  @MinLength(1)
  title: string;

  @IsString()
  @MinLength(1)
  company: string;

  @IsString()
  @IsOptional()
  location?: string;

  @IsString()
  @MinLength(1)
  description: string;

  @IsUrl({ require_tld: false })
  url: string;
}
