import type { FastifyInstance, FastifyRequest } from 'fastify';
import { getProxyToken } from '../auth/token-auth.js';
import { config } from '../config.js';
import { isKnownModel } from '../providers/known-models.js';

const FALLBACK_HOP_HEADER = 'x-cross-provider-fallback-hop';
const STRIPPED_REQUEST_HEADERS = new Set([
  'authorization', 'x-api-key', 'api-key', 'apikey', 'host', 'content-length',
  'connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate',
  'te', 'trailer', 'transfer-encoding', 'upgrade', FALLBACK_HOP_HEADER,
]);

function strippedRequestHeaders(req: FastifyRequest): Set<string> {
  const stripped = new Set(STRIPPED_REQUEST_HEADERS);
  const connection = req.headers.connection;
  for (const value of Array.isArray(connection) ? connection : [connection]) {
    for (const name of String(value ?? '').split(',')) {
      const normalized = name.trim().toLowerCase();
      if (normalized) stripped.add(normalized);
    }
  }
  return stripped;
}

export function isCrossProviderFallbackEligible(status: number): boolean {
  return status === 429 || status === 529 || status >= 500;
}

function configuredAnthropicToGlmModel(): string | null {
  const model = config.crossProviderFallbackAnthropicToGlmModel.trim();
  return config.crossProviderFallbackEnabled && isKnownModel('glm', model) ? model : null;
}

function proxyAuthorization(req: FastifyRequest): string | null {
  const token = getProxyToken(req);
  return token ? `Bearer ${token}` : null;
}

/**
 * Relay a failed, non-streaming Anthropic request through GLM's existing route.
 * The injected route repeats normal token authentication and model policy checks.
 */
export async function fallbackAnthropicToGlm(
  app: FastifyInstance,
  req: FastifyRequest,
  body: any,
  status: number,
): Promise<{ statusCode: number; body: string; contentType?: string; gatewayHeaders: Record<string, string> } | null> {
  if (!isCrossProviderFallbackEligible(status) || !!body?.stream || req.headers[FALLBACK_HOP_HEADER]) return null;
  const model = configuredAnthropicToGlmModel();
  const authorization = proxyAuthorization(req);
  if (!model || !authorization) return null;

  const headers: Record<string, string> = {};
  const stripped = strippedRequestHeaders(req);
  for (const [name, value] of Object.entries(req.headers)) {
    if (value == null || stripped.has(name.toLowerCase())) continue;
    headers[name] = Array.isArray(value) ? value.join(',') : String(value);
  }
  headers['content-type'] = 'application/json';
  headers.authorization = authorization;
  headers[FALLBACK_HOP_HEADER] = 'anthropic-to-glm';

  const result = await (app as any).inject({
    method: 'POST',
    url: '/v1/glm/v1/messages',
    headers,
    payload: { ...body, model },
  });
  const gatewayHeaders: Record<string, string> = {};
  for (const name of ['x-gateway-provider', 'x-gateway-account', 'x-gateway-attempt', 'retry-after']) {
    const value = result.headers[name];
    if (value) gatewayHeaders[name] = String(value);
  }
  return {
    statusCode: result.statusCode,
    body: result.body,
    contentType: result.headers['content-type'],
    gatewayHeaders,
  };
}
