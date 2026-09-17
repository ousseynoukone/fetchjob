import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PlatformCredentialsModule } from '../platform-credentials/platform-credentials.module';
import { AutoApplyModule } from '../auto-apply/auto-apply.module';
import { VerificationService } from './verification.service';
import { VerificationController } from './verification.controller';

@Module({
  imports: [CommonModule, PlatformCredentialsModule, AutoApplyModule],
  providers: [VerificationService],
  controllers: [VerificationController],
})
export class VerificationModule {}
