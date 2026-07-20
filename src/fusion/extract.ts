import { PROVIDER_ROUTES } from './translate.js';
import { parseProviderModel } from './presets.js';

export interface ExtractedResult {
  content: string;
  inputTokens: number;
  outputTokens: number;
}

/**
 * Extract text content + usage from an Anthropic /v1/messages response body.
 *
 * Shape:
 * {
 *   "content": [{"type": "text", "text": "..."}],
 *   "usage": {"input_tokens": N, "output_tokens": N}
 * }
 */
export function extractFromAnthropic(body: string): ExtractedResult {
  try {
    const parsed = JSON.parse(body);
    const parts: string[] = [];
    if (Array.isArray(parsed.content)) {
      for (const block of parsed.content) {
        if (block?.type === 'text' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
    const u = parsed.usage || {};
    return {
      content: parts.join(''),
      inputTokens: u.input_tokens || 0,
      outputTokens: u.output_tokens || 0,
    };
  } catch {
    return { content: '', inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * Extract text from OpenAI Codex /v1/responses response body.
 *
 * The Codex proxy may stream internally and return SSE lines, or it may
 * return a JSON object. We try JSON first; if that fails we parse SSE lines.
 *
 * JSON shape:
 * {
 *   "output": [{"content": [{"type": "output_text", "text": "..."}]}],
 *   "usage": {"input_tokens": N, "output_tokens": N}
 * }
 *
 * SSE shape (streamed): lines like:
 * data: {"type":"response.output_text.delta","delta":"..."}
 * data: {"type":"response.completed","response":{"usage":{...},"output":[...]}}
 */
export function extractFromCodex(body: string): ExtractedResult {
  // Try JSON first
  try {
    const trimmed = body.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      const parsed = JSON.parse(trimmed);
      return extractFromCodexJson(parsed);
    }
  } catch {
    // fall through to SSE parsing
  }

  // Parse SSE lines
  return extractFromCodexSse(body);
}

function extractFromCodexJson(parsed: any): ExtractedResult {
  const parts: string[] = [];

  // output_text top-level (shortcut)
  if (typeof parsed.output_text === 'string') {
    parts.push(parsed.output_text);
  }

  // output array of message items
  if (Array.isArray(parsed.output)) {
    for (const item of parsed.output) {
      if (Array.isArray(item.content)) {
        for (const block of item.content) {
          if (block?.type === 'output_text' && typeof block.text === 'string') {
            parts.push(block.text);
          }
        }
      }
    }
  }

  const u = parsed.usage || {};
  return {
    content: parts.join(''),
    inputTokens: u.input_tokens || u.prompt_tokens || 0,
    outputTokens: u.output_tokens || u.completion_tokens || 0,
  };
}

function extractFromCodexSse(body: string): ExtractedResult {
  const textParts: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;

  const lines = body.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trimStart();
    if (!payload || payload === '[DONE]') continue;
    try {
      const evt = JSON.parse(payload);
      // Streaming delta
      if (evt.type === 'response.output_text.delta' && typeof evt.delta === 'string') {
        textParts.push(evt.delta);
      }
      // Completed event
      if (evt.type === 'response.completed' || evt.type === 'response.done') {
        const resp = evt.response || evt;
        const extracted = extractFromCodexJson(resp);
        if (extracted.content && !textParts.length) {
          textParts.push(extracted.content);
        }
        if (extracted.inputTokens) inputTokens = extracted.inputTokens;
        if (extracted.outputTokens) outputTokens = extracted.outputTokens;
      }
      // Usage in streaming
      if (evt.usage) {
        inputTokens = evt.usage.input_tokens || evt.usage.prompt_tokens || inputTokens;
        outputTokens = evt.usage.output_tokens || evt.usage.completion_tokens || outputTokens;
      }
    } catch {
      // ignore malformed JSON
    }
  }

  return {
    content: textParts.join(''),
    inputTokens,
    outputTokens,
  };
}

/**
 * Extract text content + usage from an OpenAI-compat response body.
 *
 * Shape:
 * {
 *   "choices": [{"message": {"content": "..."}}],
 *   "usage": {"prompt_tokens": N, "completion_tokens": N}
 * }
 */
export function extractFromOpenAiCompat(body: string): ExtractedResult {
  try {
    const parsed = JSON.parse(body);
    let content = '';
    if (Array.isArray(parsed.choices) && parsed.choices.length > 0) {
      const msg = parsed.choices[0]?.message;
      if (typeof msg?.content === 'string') {
        content = msg.content;
      } else if (Array.isArray(msg?.content)) {
        content = msg.content
          .map((p: any) => (typeof p?.text === 'string' ? p.text : typeof p === 'string' ? p : ''))
          .join('');
      }
    }
    const u = parsed.usage || {};
    return {
      content,
      inputTokens: u.prompt_tokens || u.input_tokens || 0,
      outputTokens: u.completion_tokens || u.output_tokens || 0,
    };
  } catch {
    return { content: '', inputTokens: 0, outputTokens: 0 };
  }
}

/**
 * Extract text content + usage from a sub-call response body based on provider format.
 */
export function extractFromResponse(providerModel: string, body: string): ExtractedResult {
  const [provider] = parseProviderModel(providerModel);
  const route = PROVIDER_ROUTES[provider];
  if (!route) {
    return { content: '', inputTokens: 0, outputTokens: 0 };
  }
  switch (route.format) {
    case 'anthropic':
      return extractFromAnthropic(body);
    case 'openai_codex':
    case 'xai_responses':
      return extractFromCodex(body);
    case 'openai_compat':
      return extractFromOpenAiCompat(body);
    default:
      return { content: '', inputTokens: 0, outputTokens: 0 };
  }
}
