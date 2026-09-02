import { IsIn } from 'class-validator';

const STATUSES = ['to_apply', 'applied', 'interview', 'offer', 'rejected', 'ignored'];

export class UpdateStatusDto {
  @IsIn(STATUSES)
  status: string;
}
