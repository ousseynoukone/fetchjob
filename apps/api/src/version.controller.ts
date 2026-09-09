import { Controller, Get } from '@nestjs/common';

// Temporary diagnostic endpoint to verify which build is actually live on
// Render from the outside, without shell access (not on the free plan).
// Safe to remove once the deploy discrepancy is resolved.
const BUILD_MARKER = 'auto-apply-2026-09-09-diag-1';

@Controller('version')
export class VersionController {
  @Get()
  get() {
    return { build: BUILD_MARKER };
  }
}
