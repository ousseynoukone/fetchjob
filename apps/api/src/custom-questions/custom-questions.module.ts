import { Module } from '@nestjs/common';
import { CustomQuestionsController } from './custom-questions.controller';
import { CustomQuestionsService } from './custom-questions.service';
import { CommonModule } from '../common/common.module';
import { EmailModule } from '../email/email.module';

@Module({
  imports: [CommonModule, EmailModule],
  controllers: [CustomQuestionsController],
  providers: [CustomQuestionsService],
  exports: [CustomQuestionsService],
})
export class CustomQuestionsModule {}
