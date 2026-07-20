import { ProxyAgent } from 'undici';
import { config } from '../config.js';

// xAI region egress:
// Some xAI models (currently grok-4.5) are region-gated and return HTTP 403
// "not available in your region" when called from the gateway's EU host IP.
// When XAI_PROXY_URL is set, upstream requests for those region-gated models
// are routed through that forward proxy (e.g. a US HTTP proxy) so the upstream
// sees a supported region. This is scoped to the region-gated models only:
// all other xAI models (grok-4.3, imagine, tts, stt, realtime, batch, videos)
// keep using the gateway's direct connection.

// Models known to be region-gated and therefore routed via the proxy.
const XAI_REGION_GATED_MODELS = new Set<string>(['grok-4.5']);

let cachedAgent: ProxyAgent | null = null;
let cachedUrl: string | null = null;

export function isXaiRegionGatedModel(model: string | undefined): boolean {
  return XAI_REGION_GATED_MODELS.has((model || '').toLowerCase());
}

function resolveProxyAgent(): ProxyAgent | undefined {
  const url = (config.xaiProxyUrl || '').trim();
  if (!url) return undefined;
  if (cachedAgent && cachedUrl === url) return cachedAgent;
  cachedAgent = new ProxyAgent(url);
  cachedUrl = url;
  return cachedAgent;
}

// Returns fetch init fields to merge into an xAI upstream fetch() call.
// Only region-gated models (e.g. grok-4.5) route through the proxy; everything
// else — and any request when XAI_PROXY_URL is unset — connects directly.
export function xaiFetchDispatcher(model?: string): { dispatcher?: ProxyAgent } {
  if (!isXaiRegionGatedModel(model)) return {};
  const dispatcher = resolveProxyAgent();
  return dispatcher ? { dispatcher } : {};
}

// Exposed for tests / diagnostics.
export function getXaiDispatcher(): ProxyAgent | undefined {
  return resolveProxyAgent();
}
