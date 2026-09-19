import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { PlatformCredentialsModule } from '../platform-credentials/platform-credentials.module';
import { AutoApplyModule } from '../auto-apply/auto-apply.module';
import { SessionHealthService } from './session-health.service';
import { SessionHealthController } from './session-health.controller';

@Module({
  imports: [CommonModule, PlatformCredentialsModule, AutoApplyModule],
  providers: [SessionHealthService],
  controllers: [SessionHealthController],
})
export class SessionHealthModule {}
