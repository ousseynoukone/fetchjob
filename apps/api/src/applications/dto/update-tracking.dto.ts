import { IsOptional, IsString } from 'class-validator';

export class UpdateTrackingDto {
  /** New status for the application (interview, offer, rejected, applied, etc.) */
  @IsOptional()
  @IsString()
  status?: string;

  /** ISO date string for the scheduled interview */
  @IsOptional()
  @IsString()
  interviewDate?: string | null;

  /** Interview type: Téléphonique, Visio, Présentiel, Technique, RH, etc. */
  @IsOptional()
  @IsString()
  interviewType?: string | null;

  /** Free-form notes about the process */
  @IsOptional()
  @IsString()
  feedbackNote?: string | null;

  /** ISO date string when the rejection was received */
  @IsOptional()
  @IsString()
  rejectedAt?: string | null;

  /** Salary offered (free text) */
  @IsOptional()
  @IsString()
  offerSalary?: string | null;
}
