import { Module } from '@nestjs/common';
import { EmailService } from './email.service';
import { DigestService } from './digest.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  providers: [EmailService, DigestService],
  exports: [EmailService],
})
export class EmailModule {}
