import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { chromium, type Browser, type BrowserContext } from 'playwright';

const REALISTIC_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

@Injectable()
export class BrowserSessionService implements OnModuleDestroy {
  private readonly logger = new Logger(BrowserSessionService.name);
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (!this.browser) {
      // Default headless; set AUTO_APPLY_HEADLESS=false locally to watch the
      // bot work while validating selectors against the real sites.
      this.browser = await chromium.launch({ headless: process.env.AUTO_APPLY_HEADLESS !== 'false' });
    }
    return this.browser;
  }

  async createContext(sessionStateJson: string | null): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    let storageState: any;
    if (sessionStateJson) {
      try {
        storageState = JSON.parse(sessionStateJson);
      } catch {
        this.logger.warn('Stored session state was not valid JSON — starting a fresh session.');
      }
    }

    return browser.newContext({ userAgent: REALISTIC_USER_AGENT, storageState });
  }

  // Human-scale pacing between actions/candidatures — not an anti-detection
  // measure, just avoiding a bot-obvious burst of instant clicks/requests.
  async randomDelay(minMs: number, maxMs: number): Promise<void> {
    const ms = minMs + Math.random() * (maxMs - minMs);
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  async onModuleDestroy() {
    await this.browser?.close();
    this.browser = null;
  }
}
