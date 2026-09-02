import { Module } from '@nestjs/common';
import { AiService } from './ai.service';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [CommonModule],
  providers: [AiService],
  exports: [AiService],
})
export class AiModule {}
