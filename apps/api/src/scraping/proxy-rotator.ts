/**
 * proxy-rotator.ts
 * ================
 * Utility to manage a pool of HTTP/SOCKS5 proxies for scraping.
 *
 * Configuration (in .env):
 *   LINKEDIN_PROXIES=http://user:pass@host1:port\nhttp://host2:port\nsocks5://host3:1080
 *
 * Recommended proxy providers (residential IPs beat datacenter for LinkedIn):
 *   - Bright Data (formerly Luminati) — best residential pool
 *   - Oxylabs — reliable FR residential
 *   - ProxyMesh — budget rotating
 *   - Webshare — free tier (10 proxies) good for testing
 */

export interface ProxyConfig {
  server: string;
  username?: string;
  password?: string;
}

export class ProxyRotator {
  private index = 0;

  constructor(private readonly proxies: ProxyConfig[]) {}

  /** Returns the next proxy in round-robin order. Returns undefined when pool is empty (use direct). */
  next(): ProxyConfig | undefined {
    if (this.proxies.length === 0) return undefined;
    return this.proxies[this.index++ % this.proxies.length];
  }

  get size(): number {
    return this.proxies.length;
  }

  /**
   * Build from a newline-separated env variable.
   * Format: "protocol://[user:pass@]host:port"
   * Examples:
   *   http://user:secret@fr.proxy.io:8080
   *   socks5://127.0.0.1:1080
   */
  static fromEnv(envVar: string): ProxyRotator {
    const raw = process.env[envVar] ?? '';
    const proxies: ProxyConfig[] = raw
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          const url = new URL(line);
          return {
            server: `${url.protocol}//${url.hostname}:${url.port}`,
            username: url.username || undefined,
            password: url.password || undefined,
          };
        } catch {
          return { server: line };
        }
      });
    return new ProxyRotator(proxies);
  }

  /** Build directly from an array of proxy strings. */
  static fromList(lines: string[]): ProxyRotator {
    return ProxyRotator.fromEnv(''); // reuse parser via temp env
    // Note: use fromEnv with a comma-separated var or build ProxyConfig[] directly.
  }
}
