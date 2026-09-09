import { Injectable } from '@nestjs/common';
import type { Page } from 'playwright';
import { ApplyContext, ApplyResult, JobApplier } from './applier.interface';

// Fallback for sources that are aggregators, not the actual employer's
// application system (Adzuna, HelloWork, Remotive, Jobicy, The Muse,
// Arbeitnow, manually-added offers): the real "postuler" action lives on
// whatever site the posting links out to, which varies per offer and can't
// be driven generically. Rather than guess at an unknown form, this always
// hands the candidature back for manual follow-up.
@Injectable()
export class GenericRedirectApplier implements JobApplier {
  readonly credentialPlatform = null;

  async apply(page: Page, ctx: ApplyContext): Promise<ApplyResult> {
    return {
      success: false,
      note: `Cette source ne propose pas de formulaire de candidature automatisable — postulez manuellement via ${ctx.application.sourceUrl}`,
    };
  }
}
