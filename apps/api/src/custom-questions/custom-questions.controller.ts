import { Body, Controller, Delete, Get, Param, Put } from '@nestjs/common';
import { CustomQuestionsService } from './custom-questions.service';
import { SetAnswerDto } from './dto/set-answer.dto';

@Controller('questions')
export class CustomQuestionsController {
  constructor(private questions: CustomQuestionsService) {}

  @Get()
  async list() {
    return this.questions.list();
  }

  @Put(':id/answer')
  async setAnswer(@Param('id') id: string, @Body() dto: SetAnswerDto) {
    return this.questions.setAnswer(id, dto.answer);
  }

  @Delete(':id/answer')
  async clearAnswer(@Param('id') id: string) {
    return this.questions.clearAnswer(id);
  }
}
