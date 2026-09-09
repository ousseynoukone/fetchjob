import { Module } from '@nestjs/common';
import { PlatformCredentialsController } from './platform-credentials.controller';
import { PlatformCredentialsService } from './platform-credentials.service';
import { CommonModule } from '../common/common.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [CommonModule, EmailModule],
  controllers: [PlatformCredentialsController],
  providers: [PlatformCredentialsService],
  exports: [PlatformCredentialsService],
})
export class PlatformCredentialsModule {}
