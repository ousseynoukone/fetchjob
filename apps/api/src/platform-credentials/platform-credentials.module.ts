import { Module } from '@nestjs/common';
import { PlatformCredentialsController } from './platform-credentials.controller';
import { PlatformCredentialsService } from './platform-credentials.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  controllers: [PlatformCredentialsController],
  providers: [PlatformCredentialsService],
  exports: [PlatformCredentialsService],
})
export class PlatformCredentialsModule {}
