import { Module } from '@nestjs/common';
import { PlatformCredentialsController } from './platform-credentials.controller';
import { PlatformCredentialsService } from './platform-credentials.service';
import { RemoteLoginService } from './remote-login.service';
import { CommonModule } from '../common/common.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [CommonModule, EmailModule],
  controllers: [PlatformCredentialsController],
  providers: [PlatformCredentialsService, RemoteLoginService],
  exports: [PlatformCredentialsService],
})
export class PlatformCredentialsModule {}
