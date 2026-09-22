import { promises as dns } from 'dns';

// When set (e.g. http://host.docker.internal:9222), every browser this app
// drives lives inside a REAL desktop Chrome running on the host machine,
// reached over the Chrome DevTools Protocol -- the container only sends
// commands. Confirmed live from inside the api container: that browser
// reports navigator.webdriver=false, platform Win32, a genuine "Google
// Chrome" brand and a real hardware WebGL renderer ("ANGLE (NVIDIA GeForce
// RTX 4060 ... Direct3D11)") -- versus SwiftShader and a headless fingerprint
// for anything launched in here, which is what DataDome/Cloudflare kept
// flagging. Same residential IP either way (the host's).
//
// Two Chrome facts this has to work around, both confirmed live:
//  - a headed Chrome binds its debug port to 127.0.0.1 only, but Docker
//    Desktop routes host.docker.internal to the host loopback, so it's
//    reachable without any port forwarding;
//  - Chrome rejects (HTTP 500) any request whose Host header is a hostname
//    other than localhost, so the name has to be resolved to its IP first.
export const CDP_URL = process.env.BROWSER_CDP_URL || null;

export async function resolveCdpEndpoint(url: string): Promise<string> {
  const parsed = new URL(url);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(parsed.hostname) && parsed.hostname !== 'localhost') {
    const { address } = await dns.lookup(parsed.hostname, { family: 4 });
    parsed.hostname = address;
  }
  return parsed.toString();
}
