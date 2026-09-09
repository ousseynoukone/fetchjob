import { IsString, MinLength } from 'class-validator';

export class SetAnswerDto {
  @IsString()
  @MinLength(1)
  answer!: string;
}
