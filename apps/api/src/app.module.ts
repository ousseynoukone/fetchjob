import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AuthModule } from './auth/auth.module';
import { CvModule } from './cv/cv.module';
import { CampaignModule } from './campaign/campaign.module';
import { ApplicationsModule } from './applications/applications.module';
import { SettingsModule } from './settings/settings.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env.local',
    }),
    AuthModule,
    CvModule,
    CampaignModule,
    ApplicationsModule,
    SettingsModule,
  ],
  controllers: [],
  providers: [],
})
export class AppModule {}
