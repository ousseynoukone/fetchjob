import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthModule } from './auth/auth.module';
import { CvModule } from './cv/cv.module';
import { CampaignModule } from './campaign/campaign.module';
import { ApplicationsModule } from './applications/applications.module';
import { SettingsModule } from './settings/settings.module';
import { PlatformCredentialsModule } from './platform-credentials/platform-credentials.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { CustomQuestionsModule } from './custom-questions/custom-questions.module';
import { VerificationModule } from './verification/verification.module';
import { SessionHealthModule } from './session-health/session-health.module';
import { VersionController } from './version.controller';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env.local',
    }),
    ScheduleModule.forRoot(),
    AuthModule,
    CvModule,
    CampaignModule,
    ApplicationsModule,
    SettingsModule,
    PlatformCredentialsModule,
    KnowledgeModule,
    CustomQuestionsModule,
    VerificationModule,
    SessionHealthModule,
  ],
  controllers: [VersionController],
  providers: [],
})
export class AppModule {}
