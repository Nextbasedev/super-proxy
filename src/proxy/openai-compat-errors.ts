import { KNOWN_MODELS_BY_PROVIDER, type KnownProvider, isKnownProvider } from '../providers/known-models.js';

export type OpenAiCompatProvider = 'groq' | 'cerebras' | 'kimi' | 'gemini' | 'openrouter' | 'xai' | 'runpod' | 'glm';
export type SurfaceKind = 'non_stream' | 'stream' | 'stream_interrupted';

export interface SurfaceResult {
  changed: boolean;
  forcedLogReason?: string;
  appendSse?: string;
}

export interface OpenAiCompatStreamState {
  sawCompletion: boolean;
  sawContent: boolean;
  forcedLogReason?: string;
}

const TRUNCATED_MARKER = '\n\n[truncated: length]';
const MODEL_UNAVAILABLE_RE = /model.*not.*found|deprecated|unknown.model/i;

export function contentFilterMessage(provider: OpenAiCompatProvider): string {
  return `⛔ ${provider} safety filter blocked this response (content_filter).`;
}

export function streamInterruptedMessage(): string {
  return 'Stream interrupted; partial response above';
}

export function timeoutMessage(seconds: number): string {
  return `Request timed out at gateway after ${seconds}s. Retry is safe; idempotent.`;
}

export function transientNetworkMessage(provider: OpenAiCompatProvider): string {
  return `Transient network error reaching ${provider}; switching account.`;
}

function appendToContent(content: any, marker: string): { content: any; changed: boolean } {
  if (typeof content === 'string') {
    if (!content || content.endsWith(marker)) return { content, changed: false };
    return { content: `${content}${marker}`, changed: true };
  }
  if (Array.isArray(content)) {
    for (let i = content.length - 1; i >= 0; i--) {
      const part = content[i];
      if (part && typeof part === 'object' && typeof part.text === 'string' && part.text) {
        if (part.text.endsWith(marker)) return { content, changed: false };
        content[i] = { ...part, text: `${part.text}${marker}` };
        return { content, changed: true };
      }
    }
  }
  return { content, changed: false };
}

function replaceChoiceContent(choice: any, message: string): boolean {
  if (!choice || typeof choice !== 'object') return false;
  if (!choice.message || typeof choice.message !== 'object') choice.message = { role: 'assistant' };
  choice.message.content = message;
  return true;
}

function maybeSurfaceChoices(provider: OpenAiCompatProvider, parsed: any): SurfaceResult {
  let changed = false;
  let forcedLogReason: string | undefined;
  if (!Array.isArray(parsed?.choices)) return { changed };
  for (const choice of parsed.choices) {
    if (choice?.finish_reason === 'content_filter') {
      changed = replaceChoiceContent(choice, contentFilterMessage(provider)) || changed;
      forcedLogReason = `${provider}_content_filter`;
      continue;
    }
    if (choice?.finish_reason === 'length' && choice?.message) {
      const next = appendToContent(choice.message.content, TRUNCATED_MARKER);
      if (next.changed) {
        choice.message.content = next.content;
        changed = true;
      }
    }
  }
  return { changed, forcedLogReason };
}

function maybeSurfaceResponseObject(provider: OpenAiCompatProvider, parsed: any): SurfaceResult {
  let changed = false;
  let forcedLogReason: string | undefined;
  const reason = parsed?.finish_reason || parsed?.incomplete_details?.reason || parsed?.status_details?.reason;
  if (reason === 'content_filter') {
    const msg = contentFilterMessage(provider);
    parsed.output_text = msg;
    parsed.output = [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: msg }] }];
    changed = true;
    forcedLogReason = `${provider}_content_filter`;
  } else if ((reason === 'length' || reason === 'max_output_tokens') && typeof parsed?.output_text === 'string' && parsed.output_text) {
    if (!parsed.output_text.endsWith(TRUNCATED_MARKER)) {
      parsed.output_text += TRUNCATED_MARKER;
      changed = true;
    }
  }
  return { changed, forcedLogReason };
}

export function surfaceOpenAiCompatError(
  provider: OpenAiCompatProvider,
  parsed: any,
  kind: SurfaceKind,
  message?: string,
): SurfaceResult {
  if (kind === 'stream_interrupted') {
    return { changed: true, forcedLogReason: `${provider}_stream_interrupted`, appendSse: buildStreamInterruptedSse(message) };
  }
  if (kind === 'non_stream') {
    const choices = maybeSurfaceChoices(provider, parsed);
    const responses = maybeSurfaceResponseObject(provider, parsed);
    return {
      changed: choices.changed || responses.changed,
      forcedLogReason: choices.forcedLogReason || responses.forcedLogReason,
    };
  }
  return surfaceOpenAiCompatStreamEvent(provider, parsed, { sawCompletion: false, sawContent: false });
}

function payloadFromSseEvent(event: string): string[] {
  return event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());
}

export function surfaceOpenAiCompatStreamChunk(
  provider: OpenAiCompatProvider,
  chunk: string,
  state: OpenAiCompatStreamState,
): SurfaceResult {
  let appendSse = '';
  let changed = false;
  for (const event of chunk.split(/\n\n/)) {
    const payloads = payloadFromSseEvent(event);
    if (!payloads.length) continue;
    const payload = payloads.join('\n').trim();
    if (!payload) continue;
    if (payload === '[DONE]') {
      state.sawCompletion = true;
      continue;
    }
    try {
      const parsed = JSON.parse(payload);
      const result = surfaceOpenAiCompatStreamEvent(provider, parsed, state);
      if (result.appendSse) appendSse += result.appendSse;
      if (result.changed) changed = true;
      if (result.forcedLogReason) state.forcedLogReason = result.forcedLogReason;
    } catch {}
  }
  return { changed, forcedLogReason: state.forcedLogReason, appendSse: appendSse || undefined };
}

function surfaceOpenAiCompatStreamEvent(
  provider: OpenAiCompatProvider,
  parsed: any,
  state: OpenAiCompatStreamState,
): SurfaceResult {
  let appendSse = '';
  let forcedLogReason: string | undefined;
  let changed = false;

  if (
    parsed?.type === 'response.completed'
    || parsed?.type === 'response.done'
    || parsed?.type === 'done'
    // Anthropic-compatible streams (used by GLM) finish with message_stop, not
    // OpenAI-style [DONE]/response.completed. Treat it as a valid completion so
    // the gateway does not append a fake "stream interrupted" error after a
    // perfectly complete response.
    || parsed?.type === 'message_stop'
  ) {
    state.sawCompletion = true;
  }

  if (parsed?.type === 'content_block_delta' && typeof parsed?.delta?.text === 'string' && parsed.delta.text.length > 0) {
    state.sawContent = true;
  }

  const choices = Array.isArray(parsed?.choices) ? parsed.choices : [];
  for (const choice of choices) {
    const deltaContent = choice?.delta?.content;
    if (typeof deltaContent === 'string' && deltaContent.length > 0) state.sawContent = true;
    if (choice?.finish_reason === 'content_filter') {
      appendSse += `data: ${JSON.stringify({ choices: [{ index: choice.index ?? 0, delta: { content: contentFilterMessage(provider) }, finish_reason: null }] })}\n\n`;
      forcedLogReason = `${provider}_content_filter`;
      changed = true;
    } else if (choice?.finish_reason === 'length' && state.sawContent) {
      appendSse += `data: ${JSON.stringify({ choices: [{ index: choice.index ?? 0, delta: { content: TRUNCATED_MARKER }, finish_reason: null }] })}\n\n`;
      changed = true;
    }
  }

  return { changed, forcedLogReason, appendSse: appendSse || undefined };
}

export function buildStreamInterruptedSse(message = streamInterruptedMessage()): string {
  return `data: ${JSON.stringify({ error: { message } })}\n\ndata: [DONE]\n\n`;
}

export function isModelUnavailableError(status: number, text: string): boolean {
  return status === 400 && MODEL_UNAVAILABLE_RE.test(text || '');
}

export function modelUnavailableError(provider: OpenAiCompatProvider, model: string) {
  const known = isKnownProvider(provider) ? KNOWN_MODELS_BY_PROVIDER[provider as KnownProvider] : [];
  const suggestion = known[0] || 'a known supported model';
  return { error: { message: `Model ${model} is not available on ${provider}. Try: ${suggestion}`, type: 'invalid_request_error', code: 'model_not_available' } };
}

export function isAbortTimeoutError(err: any): boolean {
  return err?.name === 'TimeoutError'
    || err?.code === 'ABORT_ERR'
    || /timeout|timed out|operation was aborted/i.test(String(err?.message || err || ''));
}

export function timeoutSeconds(ms: number): number {
  return Math.max(1, Math.round(ms / 1000));
}
