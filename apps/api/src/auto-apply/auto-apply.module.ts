import { Module } from '@nestjs/common';
import { CommonModule } from '../common/common.module';
import { CvModule } from '../cv/cv.module';
import { PdfModule } from '../pdf/pdf.module';
import { PlatformCredentialsModule } from '../platform-credentials/platform-credentials.module';
import { CustomQuestionsModule } from '../custom-questions/custom-questions.module';
import { AutoApplyService } from './auto-apply.service';
import { BrowserSessionService } from './browser-session.service';
import { LinkedInApplier } from './appliers/linkedin.applier';
import { IndeedApplier } from './appliers/indeed.applier';
import { FranceTravailApplier } from './appliers/france-travail.applier';
import { HelloWorkApplier } from './appliers/hellowork.applier';
import { GreenhouseApplier } from './appliers/greenhouse.applier';
import { LeverApplier } from './appliers/lever.applier';
import { WorkdayApplier } from './appliers/workday.applier';
import { SmartRecruitersApplier } from './appliers/smartrecruiters.applier';
import { GenericRedirectApplier } from './appliers/generic-redirect.applier';

@Module({
  imports: [CommonModule, CvModule, PdfModule, PlatformCredentialsModule, CustomQuestionsModule],
  providers: [
    AutoApplyService,
    BrowserSessionService,
    LinkedInApplier,
    IndeedApplier,
    FranceTravailApplier,
    HelloWorkApplier,
    GreenhouseApplier,
    LeverApplier,
    WorkdayApplier,
    SmartRecruitersApplier,
    GenericRedirectApplier,
  ],
  exports: [AutoApplyService],
})
export class AutoApplyModule {}
