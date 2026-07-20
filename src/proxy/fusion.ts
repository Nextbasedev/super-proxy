import type { FastifyInstance } from 'fastify';
import { writeRawResponseHead } from '../http/response-headers.js';
import crypto from 'node:crypto';
import { requireProxyToken } from '../auth/token-auth.js';
import { authorizeEffectiveModelForUser, isModelAllowedForUser } from './policy.js';
import { recordUsage } from './usage.js';
import { estimateCost } from './cost.js';
import { alert } from '../utils/alerts.js';
import {
  resolveBuiltInPreset,
  resolveUserPreset,
  mergePresetWithInline,
  validateFusionConfig,
  parseProviderModel,
} from '../fusion/presets.js';
import { getDb } from '../db/index.js';
import { getProviderRoute, translateRequest } from '../fusion/translate.js';
import { extractFromResponse } from '../fusion/extract.js';
import { buildSynthesizerChatMessages } from '../fusion/synthesizer.js';
import type {
  FusionRequestBody,
  FusionPreset,
  PanelResult,
  PanelFailure,
  FusionMetadata,
  FusionThinkingConfig,
} from '../fusion/types.js';

function fusionError(code: string, message: string, status = 400) {
  return { status, body: { error: { type: 'fusion_error', code, message } } };
}

function normalizeFusionAccessModel(modelAlias: string): string {
  if (modelAlias === 'fusion') return 'quality';
  if (modelAlias.startsWith('fusion/')) return modelAlias.slice('fusion/'.length);
  return modelAlias;
}

/**
 * Record a row in the fusion_calls audit table.
 */
function recordFusionCall(params: {
  parentUsageEventId: number;
  userId: number;
  preset: string;
  panelModels: string[];
  synthesizerModel: string;
  panelSucceeded: number;
  panelFailed: number;
  failedModels: Array<{ model: string; error: string }>;
  synthesizerSucceeded: boolean;
  synthesizerSkipped: boolean;
  totalLatencyMs: number;
  panelLatencyMs: number;
  synthesizerLatencyMs?: number;
}): void {
  try {
    getDb().prepare(`
      INSERT INTO fusion_calls (
        parent_usage_event_id, user_id, preset, panel_models_json, synthesizer_model,
        panel_succeeded, panel_failed, failed_models_json,
        synthesizer_succeeded, synthesizer_skipped,
        total_latency_ms, panel_latency_ms, synthesizer_latency_ms
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      params.parentUsageEventId,
      params.userId,
      params.preset,
      JSON.stringify(params.panelModels),
      params.synthesizerModel,
      params.panelSucceeded,
      params.panelFailed,
      JSON.stringify(params.failedModels),
      params.synthesizerSucceeded ? 1 : 0,
      params.synthesizerSkipped ? 1 : 0,
      params.totalLatencyMs,
      params.panelLatencyMs,
      params.synthesizerLatencyMs ?? null,
    );
  } catch {
    // Never let audit recording crash the request
  }
}

/**
 * Execute a single panel sub-call via app.inject().
 * Returns PanelResult on success, throws on failure.
 */
async function executePanelCall(
  app: FastifyInstance,
  authToken: string,
  providerModel: string,
  messages: any[],
  maxTokens: number,
  timeoutMs: number,
  thinkingConfig?: FusionThinkingConfig,
): Promise<PanelResult> {
  const started = Date.now();
  const route = getProviderRoute(providerModel);

  // Translate the request body for the target provider
  const payload = translateRequest(providerModel, messages, maxTokens, false /* panel never streams */, undefined, thinkingConfig);

  // Execute via inject — abort-via-timeout wrapping
  let responseBody: string;
  let statusCode: number;

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), timeoutMs);

  try {
    const injectPromise = (app as any).inject({
      method: 'POST',
      url: route.url,
      headers: {
        'content-type': 'application/json',
        authorization: authToken,
        'x-fusion-depth': '1',
        'x-headroom-compressed': 'true', // prevent double-compression on panel sub-requests
      },
      payload,
    });

    // Race the inject call against the timeout
    const result = await Promise.race([
      injectPromise,
      new Promise<never>((_, reject) =>
        timeoutController.signal.addEventListener('abort', () =>
          reject(new Error(`Panel call timeout after ${timeoutMs}ms for ${providerModel}`)),
        ),
      ),
    ]);

    clearTimeout(timeoutId);
    statusCode = result.statusCode;
    responseBody = result.body;
  } catch (err: any) {
    clearTimeout(timeoutId);
    throw err;
  }

  if (statusCode >= 400) {
    throw new Error(`Panel call to ${providerModel} failed with status ${statusCode}: ${responseBody.slice(0, 500)}`);
  }

  const extracted = extractFromResponse(providerModel, responseBody);

  if (!extracted.content) {
    throw new Error(`Panel call to ${providerModel} returned empty content`);
  }

  return {
    model: providerModel,
    content: extracted.content,
    inputTokens: extracted.inputTokens,
    outputTokens: extracted.outputTokens,
    latencyMs: Date.now() - started,
  };
}

/**
 * Execute the synthesizer call via app.inject().
 * Returns the synthesized text and usage.
 */
const SYNTHESIZER_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — synthesizer processes all panel responses

async function executeSynthesizerCall(
  app: FastifyInstance,
  authToken: string,
  providerModel: string,
  messages: any[],
  maxTokens: number,
  thinkingConfig?: FusionThinkingConfig,
): Promise<{ content: string; inputTokens: number; outputTokens: number; latencyMs: number }> {
  const started = Date.now();
  const route = getProviderRoute(providerModel);

  // Synthesizer is always non-streaming (Option A from spec)
  const payload = translateRequest(providerModel, messages, maxTokens, false, undefined, thinkingConfig);

  const timeoutController = new AbortController();
  const timeoutId = setTimeout(() => timeoutController.abort(), SYNTHESIZER_TIMEOUT_MS);

  let result: any;
  try {
    result = await Promise.race([
      (app as any).inject({
        method: 'POST',
        url: route.url,
        headers: {
          'content-type': 'application/json',
          authorization: authToken,
          'x-fusion-depth': '1',
          'x-headroom-compressed': 'true',
        },
        payload,
      }),
      new Promise<never>((_, reject) =>
        timeoutController.signal.addEventListener('abort', () =>
          reject(new Error(`Synthesizer call timeout after ${SYNTHESIZER_TIMEOUT_MS}ms for ${providerModel}`)),
        ),
      ),
    ]);
    clearTimeout(timeoutId);
  } catch (err: any) {
    clearTimeout(timeoutId);
    throw err;
  }

  if (result.statusCode >= 400) {
    throw new Error(`Synthesizer call to ${providerModel} failed with status ${result.statusCode}: ${String(result.body).slice(0, 500)}`);
  }

  const extracted = extractFromResponse(providerModel, result.body);
  return {
    content: extracted.content,
    inputTokens: extracted.inputTokens,
    outputTokens: extracted.outputTokens,
    latencyMs: Date.now() - started,
  };
}

/**
 * Build a standard /chat/completions response object.
 */
function buildChatCompletionResponse(
  fusionModel: string,
  content: string,
  usage: { inputTokens: number; outputTokens: number },
  fusionMeta: FusionMetadata,
  choices?: Array<{ index: number; model?: string; content: string }>,
): any {
  const id = `fusion-${crypto.randomBytes(8).toString('hex')}`;
  const created = Math.floor(Date.now() / 1000);

  if (choices && choices.length > 1) {
    // Compare mode — multiple choices
    return {
      id,
      object: 'chat.completion',
      created,
      model: fusionModel,
      choices: choices.map((c) => ({
        index: c.index,
        message: { role: 'assistant', content: c.content },
        finish_reason: 'stop',
        model: c.model,
      })),
      usage: {
        prompt_tokens: usage.inputTokens,
        completion_tokens: usage.outputTokens,
        total_tokens: usage.inputTokens + usage.outputTokens,
      },
      fusion: fusionMeta,
    };
  }

  // Single choice (synthesize mode or single panel fallback)
  return {
    id,
    object: 'chat.completion',
    created,
    model: fusionModel,
    choices: [{
      index: 0,
      message: { role: 'assistant', content },
      finish_reason: 'stop',
    }],
    usage: {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.inputTokens + usage.outputTokens,
    },
    fusion: fusionMeta,
  };
}

/**
 * Stream a pre-composed text response to the client as SSE chat.completion.chunk events.
 */
function streamTextAsSSE(reply: any, id: string, model: string, content: string): void {
  const created = Math.floor(Date.now() / 1000);

  // Send role chunk first
  const roleChunk = JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
  });
  reply.raw.write(`data: ${roleChunk}\n\n`);

  // Stream content in chunks of ~512 chars to give the appearance of streaming
  const CHUNK_SIZE = 512;
  for (let i = 0; i < content.length; i += CHUNK_SIZE) {
    const chunk = content.slice(i, i + CHUNK_SIZE);
    const chunkEvent = JSON.stringify({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { content: chunk }, finish_reason: null }],
    });
    reply.raw.write(`data: ${chunkEvent}\n\n`);
  }

  // Send stop chunk
  const stopChunk = JSON.stringify({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
  });
  reply.raw.write(`data: ${stopChunk}\n\n`);
  reply.raw.write('data: [DONE]\n\n');
}

/**
 * Fusion orchestrator.
 *
 * Two-layer architecture: PANEL (parallel) → SYNTHESIZER.
 *
 * Flow:
 * 1. Auth + recursion guard
 * 2. Resolve preset (built-in / user-saved / inline custom)
 * 3. Pre-flight model access check — drop inaccessible panel models
 * 4. PANEL: Promise.allSettled fanout via app.inject() to provider proxies
 * 5. If all failed → 503. If 1 succeeded → return directly (skip synthesizer).
 * 6. COMPARE mode → return panel responses side-by-side
 * 7. SYNTHESIZE mode → build prompt with panel responses, call synthesizer
 * 8. If synthesizer fails → fall back to best panel response
 * 9. Record parent usage_event + fusion_calls audit row
 *
 * Every sub-call goes through existing proxy handlers via app.inject(),
 * so it inherits auth, pooling, retries, cooldowns, and usage recording.
 */
export function registerFusionProxy(app: FastifyInstance) {
  app.post('/v1/fusion/chat/completions', async (req, reply) => {
    const auth = await requireProxyToken(req, reply);
    if (!auth) return;

    const started = Date.now();
    const body = req.body as FusionRequestBody;
    const modelAlias = typeof body?.model === 'string' ? body.model : 'fusion';
    const clientStream = !!body?.stream;
    const messages = Array.isArray(body?.messages) ? body.messages : [];

    const fusionAllowed = isModelAllowedForUser(auth.user, 'fusion', normalizeFusionAccessModel(modelAlias));
    if (!fusionAllowed.ok) {
      reply.code(403).send(fusionError('model_not_allowed_for_user', fusionAllowed.message, 403).body);
      return;
    }

    // ─── Recursion check ─────────────────────────────────────────────────────
    const fusionDepth = parseInt(String(req.headers['x-fusion-depth'] || '0'), 10);
    if (fusionDepth >= 1) {
      reply.code(400).send(fusionError('recursion_detected', 'Nested fusion calls are not allowed. x-fusion-depth header indicates this is already a sub-call.').body);
      return;
    }

    // ─── Resolve preset ───────────────────────────────────────────────────────
    let preset: FusionPreset | null = resolveBuiltInPreset(modelAlias);
    // Track the resolved preset name for fusion_calls audit (strip "fusion/" prefix)
    let resolvedPresetName: string = modelAlias.startsWith('fusion/')
      ? modelAlias.slice('fusion/'.length)
      : 'quality';

    if (!preset) {
      // Handle fusion/custom or look up user-saved presets
      if (modelAlias === 'fusion/custom') {
        if (!body.fusion || !Array.isArray(body.fusion.panel) || body.fusion.panel.length === 0) {
          reply.code(400).send(fusionError('missing_fusion_config', 'model "fusion/custom" requires a "fusion" body with panel and synthesizer fields.').body);
          return;
        }
        const validation = validateFusionConfig(body.fusion as any);
        if (!validation.ok) {
          reply.code(400).send(fusionError('invalid_fusion_config', validation.message).body);
          return;
        }
        // Build a preset from the inline config
        preset = {
          name: 'custom',
          panel: body.fusion.panel!,
          synthesizer: body.fusion.synthesizer!,
          panel_max_tokens: body.fusion.panel_max_tokens ?? 4096,
          synthesizer_max_tokens: body.fusion.synthesizer_max_tokens ?? 8192,
          panel_timeout_ms: body.fusion.panel_timeout_ms ?? 120_000,
          mode: body.fusion.mode ?? 'synthesize',
          thinking: body.fusion.thinking as FusionThinkingConfig | undefined,
        };
        resolvedPresetName = 'custom';
      } else if (modelAlias.startsWith('fusion/')) {
        // Try to look up user's saved custom preset by name
        const customName = modelAlias.slice('fusion/'.length);
        const userPreset = resolveUserPreset(auth.user.id, customName);
        if (!userPreset) {
          reply.code(400).send(fusionError('unknown_preset', `Unknown fusion preset: "${modelAlias}". Check your saved presets at /api/me/fusion-presets or use a built-in preset.`).body);
          return;
        }
        preset = userPreset;
        resolvedPresetName = customName;
      } else {
        reply.code(400).send(fusionError('unknown_preset', `Unknown fusion model alias: "${modelAlias}". Use "fusion", "fusion/quality", "fusion/budget", "fusion/custom", or a saved preset.`).body);
        return;
      }
    }

    // ─── Merge inline fusion body over preset defaults ─────────────────────
    if (body.fusion && preset.name !== 'custom') {
      // Validate inline overrides if panel is specified
      if (body.fusion.panel) {
        const validation = validateFusionConfig({ panel: body.fusion.panel, synthesizer: body.fusion.synthesizer || preset.synthesizer });
        if (!validation.ok) {
          reply.code(400).send(fusionError('invalid_fusion_config', validation.message).body);
          return;
        }
      }
      preset = mergePresetWithInline(preset, body.fusion as any);
    }

    // Saved presets predate exact catalog validation and may contain stale or
    // fabricated IDs. Validate every resolved preset before any sub-call.
    const resolvedValidation = validateFusionConfig(preset);
    if (!resolvedValidation.ok) {
      reply.code(400).send(fusionError('invalid_fusion_config', resolvedValidation.message).body);
      return;
    }

    const mode = preset.mode;
    const panelModels = preset.panel;
    const synthesizerModel = preset.synthesizer;
    const panelMaxTokens = preset.panel_max_tokens;
    const synthesizerMaxTokens = preset.synthesizer_max_tokens;
    const panelTimeoutMs = preset.panel_timeout_ms;
    const thinkingConfig = preset.thinking;

    // ─── Pre-flight: check model access ──────────────────────────────────────
    const accessiblePanelModels: string[] = [];
    const preflightFailures: PanelFailure[] = [];

    for (const providerModel of panelModels) {
      try {
        const [provider, model] = parseProviderModel(providerModel);
        const allowed = authorizeEffectiveModelForUser(auth.user, provider, model);
        if (allowed.ok) {
          accessiblePanelModels.push(providerModel);
        } else {
          preflightFailures.push({ model: providerModel, error: allowed.message, statusCode: 403 });
        }
      } catch (err: any) {
        preflightFailures.push({ model: providerModel, error: err?.message || String(err), statusCode: 400 });
      }
    }

    if (accessiblePanelModels.length === 0) {
      reply.code(403).send(fusionError('no_accessible_panel_models', `No panel models are accessible for this user. Checked: ${panelModels.join(', ')}`).body);
      return;
    }

    if (mode === 'synthesize' && accessiblePanelModels.length > 1) {
      try {
        const [synthProvider, synthModel] = parseProviderModel(synthesizerModel);
        const synthAllowed = authorizeEffectiveModelForUser(auth.user, synthProvider, synthModel);
        if (!synthAllowed.ok) {
          reply.code(403).send(fusionError('synthesizer_model_not_allowed', synthAllowed.message, 403).body);
          return;
        }
      } catch (err: any) {
        reply.code(400).send(fusionError('invalid_fusion_config', err?.message || String(err)).body);
        return;
      }
    }

    // Grab the raw auth token to forward to sub-calls
    const rawAuthHeader = String(req.headers.authorization || req.headers['x-api-key'] || req.headers['api-key'] || req.headers.apikey || '');
    // Normalize to Bearer format if needed
    const authToken = rawAuthHeader.startsWith('Bearer ') || rawAuthHeader.startsWith('bearer ')
      ? rawAuthHeader
      : `Bearer ${rawAuthHeader}`;

    // ─── PANEL PHASE ─────────────────────────────────────────────────────────
    const panelStarted = Date.now();
    const panelSettled = await Promise.allSettled(
      accessiblePanelModels.map((providerModel) =>
        executePanelCall(app, authToken, providerModel, messages, panelMaxTokens, panelTimeoutMs, thinkingConfig),
      ),
    );

    const panelResults: PanelResult[] = [];
    const panelFailures: PanelFailure[] = [...preflightFailures];

    for (let i = 0; i < panelSettled.length; i++) {
      const settled = panelSettled[i];
      if (settled.status === 'fulfilled') {
        panelResults.push(settled.value);
      } else {
        panelFailures.push({
          model: accessiblePanelModels[i],
          error: settled.reason?.message || String(settled.reason),
        });
      }
    }

    const panelLatencyMs = Date.now() - panelStarted;

    // All panel models failed → 503
    if (panelResults.length === 0) {
      const errors = panelFailures.map((f) => `${f.model}: ${f.error}`).join('; ');
      void alert('error', 'fusion_all_panels_failed', `Fusion: all ${panelFailures.length} panel models failed for user ${auth.user.email}`, {
        userId: auth.user.id,
        preset: resolvedPresetName,
        panelModels: accessiblePanelModels,
        failures: panelFailures.map((f) => ({ model: f.model, error: f.error.slice(0, 200) })),
      });

      const totalLatencyMs = Date.now() - started;
      recordUsage({
        userId: auth.user.id,
        tokenId: auth.token.id,
        provider: 'fusion',
        endpoint: '/v1/fusion/chat/completions',
        model: modelAlias,
        stream: clientStream,
        statusCode: 503,
        latencyMs: totalLatencyMs,
        error: `all_panels_failed: ${errors.slice(0, 500)}`,
        tokenLabel: auth.token.label,
      });

      reply.code(503).send(fusionError('all_panels_failed', `All panel models failed. Errors: ${errors}`, 503).body);
      return;
    }

    // Alert on partial panel failures (some succeeded, some failed)
    if (panelFailures.length > 0 && panelResults.length > 0) {
      void alert('warn', 'fusion_partial_panel_failure', `Fusion: ${panelFailures.length}/${panelFailures.length + panelResults.length} panel models failed for user ${auth.user.email}`, {
        userId: auth.user.id,
        preset: resolvedPresetName,
        succeeded: panelResults.map((r) => r.model),
        failures: panelFailures.map((f) => ({ model: f.model, error: f.error.slice(0, 200) })),
      });
    }

    // ─── Single panel shortcut ───────────────────────────────────────────────
    if (panelResults.length === 1) {
      const solo = panelResults[0];
      const totalLatencyMs = Date.now() - started;
      const fusionMeta: FusionMetadata = {
        mode,
        panel: {
          models: accessiblePanelModels,
          succeeded: 1,
          failed: panelFailures.length,
          failed_details: panelFailures,
          latency_ms: panelLatencyMs,
        },
        synthesizer: {
          model: synthesizerModel,
          skipped: true,
          succeeded: false,
        },
        total_latency_ms: totalLatencyMs,
      };

      const totalInput = solo.inputTokens;
      const totalOutput = solo.outputTokens;
      const cost = estimateCost(undefined, { inputTokens: totalInput, outputTokens: totalOutput }, 'fusion');

      const usageEventId = recordUsage({
        userId: auth.user.id,
        tokenId: auth.token.id,
        provider: 'fusion',
        endpoint: '/v1/fusion/chat/completions',
        model: modelAlias,
        stream: clientStream,
        statusCode: 200,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        estimatedCostUsd: cost,
        latencyMs: totalLatencyMs,
        tokenLabel: auth.token.label,
      });

      recordFusionCall({
        parentUsageEventId: usageEventId,
        userId: auth.user.id,
        preset: resolvedPresetName,
        panelModels: accessiblePanelModels,
        synthesizerModel: synthesizerModel,
        panelSucceeded: 1,
        panelFailed: panelFailures.length,
        failedModels: panelFailures.map((f) => ({ model: f.model, error: f.error })),
        synthesizerSucceeded: false,
        synthesizerSkipped: true,
        totalLatencyMs,
        panelLatencyMs,
      });

      const responseObj = buildChatCompletionResponse(
        modelAlias,
        solo.content,
        { inputTokens: totalInput, outputTokens: totalOutput },
        fusionMeta,
      );

      if (clientStream) {
        writeRawResponseHead(reply, 200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'x-gateway-provider': 'fusion',
        });
        streamTextAsSSE(reply, responseObj.id, modelAlias, solo.content);
        reply.raw.end();
      } else {
        reply.code(200).type('application/json').send(responseObj);
      }
      return;
    }

    // ─── COMPARE MODE ───────────────────────────────────────────────────────
    if (mode === 'compare') {
      const totalLatencyMs = Date.now() - started;
      const totalInput = panelResults.reduce((sum, r) => sum + r.inputTokens, 0);
      const totalOutput = panelResults.reduce((sum, r) => sum + r.outputTokens, 0);

      const fusionMeta: FusionMetadata = {
        mode: 'compare',
        panel: {
          models: accessiblePanelModels,
          succeeded: panelResults.length,
          failed: panelFailures.length,
          failed_details: panelFailures,
          latency_ms: panelLatencyMs,
        },
        total_latency_ms: totalLatencyMs,
      };

      const cost = estimateCost(undefined, { inputTokens: totalInput, outputTokens: totalOutput }, 'fusion');
      const usageEventId = recordUsage({
        userId: auth.user.id,
        tokenId: auth.token.id,
        provider: 'fusion',
        endpoint: '/v1/fusion/chat/completions',
        model: modelAlias,
        stream: clientStream,
        statusCode: 200,
        inputTokens: totalInput,
        outputTokens: totalOutput,
        estimatedCostUsd: cost,
        latencyMs: totalLatencyMs,
        tokenLabel: auth.token.label,
      });

      recordFusionCall({
        parentUsageEventId: usageEventId,
        userId: auth.user.id,
        preset: resolvedPresetName,
        panelModels: accessiblePanelModels,
        synthesizerModel: synthesizerModel,
        panelSucceeded: panelResults.length,
        panelFailed: panelFailures.length,
        failedModels: panelFailures.map((f) => ({ model: f.model, error: f.error })),
        synthesizerSucceeded: false,
        synthesizerSkipped: true,
        totalLatencyMs,
        panelLatencyMs,
      });

      const responseObj = buildChatCompletionResponse(
        modelAlias,
        '',
        { inputTokens: totalInput, outputTokens: totalOutput },
        fusionMeta,
        panelResults.map((r, i) => ({ index: i, model: r.model, content: r.content })),
      );

      if (clientStream) {
        writeRawResponseHead(reply, 200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          'x-gateway-provider': 'fusion',
        });
        // For compare mode streaming, emit each model's response as separate chunks
        const id = responseObj.id;
        const created = Math.floor(Date.now() / 1000);
        for (const r of panelResults) {
          const chunk = JSON.stringify({
            id,
            object: 'chat.completion.chunk',
            created,
            model: modelAlias,
            fusion_model: r.model,
            choices: [{ index: 0, delta: { role: 'assistant', content: r.content }, finish_reason: 'stop' }],
          });
          reply.raw.write(`data: ${chunk}\n\n`);
        }
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
      } else {
        reply.code(200).type('application/json').send(responseObj);
      }
      return;
    }

    // ─── SYNTHESIZER PHASE ──────────────────────────────────────────────────
    // mode === 'synthesize' and ≥2 panel results
    let synthContent: string;
    let synthInputTokens = 0;
    let synthOutputTokens = 0;
    let synthLatencyMs = 0;
    let synthSucceeded = true;

    if (clientStream) {
      // Send progress event before synthesis starts
      writeRawResponseHead(reply, 200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'x-gateway-provider': 'fusion',
      });
      const progressEvent = JSON.stringify({
        object: 'fusion.progress',
        phase: 'panel',
        status: `${panelResults.length}/${accessiblePanelModels.length} models responded${panelFailures.length > 0 ? ` (${panelFailures.length} failed)` : ''}`,
      });
      reply.raw.write(`data: ${progressEvent}\n\n`);
    }

    const synthMessages = buildSynthesizerChatMessages(messages, panelResults);

    try {
      const synthResult = await executeSynthesizerCall(
        app,
        authToken,
        synthesizerModel,
        synthMessages,
        synthesizerMaxTokens,
        thinkingConfig,
      );
      synthContent = synthResult.content;
      synthInputTokens = synthResult.inputTokens;
      synthOutputTokens = synthResult.outputTokens;
      synthLatencyMs = synthResult.latencyMs;
    } catch (err: any) {
      // Synthesizer failed — fall back to best panel response (longest)
      synthSucceeded = false;
      const best = panelResults.reduce((a, b) => (a.content.length >= b.content.length ? a : b));
      synthContent = best.content;
      synthInputTokens = best.inputTokens;
      synthOutputTokens = best.outputTokens;

      void alert('warn', 'fusion_synthesizer_failed', `Fusion synthesizer failed for user ${auth.user.email}, falling back to panel response`, {
        userId: auth.user.id,
        preset: resolvedPresetName,
        synthesizerModel,
        error: (err?.message || String(err)).slice(0, 500),
        fallbackModel: best.model,
      });
    }

    const totalLatencyMs = Date.now() - started;
    const totalInput = panelResults.reduce((sum, r) => sum + r.inputTokens, 0) + synthInputTokens;
    const totalOutput = panelResults.reduce((sum, r) => sum + r.outputTokens, 0) + synthOutputTokens;

    const fusionMeta: FusionMetadata = {
      mode: 'synthesize',
      panel: {
        models: accessiblePanelModels,
        succeeded: panelResults.length,
        failed: panelFailures.length,
        failed_details: panelFailures,
        latency_ms: panelLatencyMs,
      },
      synthesizer: {
        model: synthesizerModel,
        latency_ms: synthLatencyMs,
        succeeded: synthSucceeded,
      },
      total_latency_ms: totalLatencyMs,
    };

    const cost = estimateCost(undefined, { inputTokens: totalInput, outputTokens: totalOutput }, 'fusion');
    const usageEventId = recordUsage({
      userId: auth.user.id,
      tokenId: auth.token.id,
      provider: 'fusion',
      endpoint: '/v1/fusion/chat/completions',
      model: modelAlias,
      stream: clientStream,
      statusCode: 200,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      estimatedCostUsd: cost,
      latencyMs: totalLatencyMs,
      // Synthesizer fallback = a rerouted request; count it as a retry so
      // fusion reroutes are visible in monitoring.
      retryCount: synthSucceeded ? undefined : 1,
      retryReason: synthSucceeded ? undefined : 'upstream_error',
      tokenLabel: auth.token.label,
    });

    recordFusionCall({
      parentUsageEventId: usageEventId,
      userId: auth.user.id,
      preset: resolvedPresetName,
      panelModels: accessiblePanelModels,
      synthesizerModel: synthesizerModel,
      panelSucceeded: panelResults.length,
      panelFailed: panelFailures.length,
      failedModels: panelFailures.map((f) => ({ model: f.model, error: f.error })),
      synthesizerSucceeded: synthSucceeded,
      synthesizerSkipped: false,
      totalLatencyMs,
      panelLatencyMs,
      synthesizerLatencyMs: synthLatencyMs > 0 ? synthLatencyMs : undefined,
    });

    const responseObj = buildChatCompletionResponse(
      modelAlias,
      synthContent,
      { inputTokens: totalInput, outputTokens: totalOutput },
      fusionMeta,
    );

    if (clientStream) {
      // Headers already written above (progress event)
      streamTextAsSSE(reply, responseObj.id, modelAlias, synthContent);
      reply.raw.end();
    } else {
      reply.code(200).type('application/json').send(responseObj);
    }
  });
}
