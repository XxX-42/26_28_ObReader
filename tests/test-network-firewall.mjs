// Restrict fixture pages to their local origin without pausing every request
// through Puppeteer's Fetch interception machinery. Blob workers remain
// available because PDF.js uses them for its worker bootstrap.
export const TEST_NETWORK_FIREWALL_CSP = [
  "default-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
  "frame-src 'self' blob:",
  "worker-src 'self' blob:",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data: blob:",
  "connect-src 'self' blob:",
  "media-src 'self' blob:",
  "manifest-src 'self'",
  "object-src 'none'",
].join("; ");

export function withTestNetworkFirewall(headers = {}) {
  return {
    ...headers,
    "content-security-policy": TEST_NETWORK_FIREWALL_CSP,
  };
}
