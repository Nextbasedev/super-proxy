import type { PanelResult } from './types.js';

const SYNTHESIZER_SYSTEM_PROMPT = `You are writing a comprehensive answer to the user's question. Multiple expert AI models have independently answered the same question. Their responses are provided below.

Your task:
1. COMPARE the responses — identify where they agree (high confidence), where they contradict each other (explain the nuance), and what unique insights individual models offered
2. Write a single authoritative answer that is BETTER than any individual response by combining the strongest elements

Rules:
- Do NOT mention "models", "responses", "analysis", or the deliberation process
- Write naturally as your own authoritative answer
- Treat points of agreement as high-confidence facts
- Where models disagree, explain the tradeoffs and your reasoning
- Incorporate unique insights that add genuine value
- Note anything important that none of the models addressed`;

/**
 * Format the original user messages for inclusion in the synthesizer prompt.
 * Shows only user/assistant turns (no system messages since they're passed separately).
 */
function formatUserMessages(messages: any[]): string {
  const parts: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'system') continue;
    const role = msg.role === 'assistant' ? 'Assistant' : 'User';
    const content = typeof msg.content === 'string'
      ? msg.content
      : Array.isArray(msg.content)
        ? msg.content.map((p: any) => (typeof p?.text === 'string' ? p.text : typeof p === 'string' ? p : '')).join('')
        : String(msg.content ?? '');
    parts.push(`${role}: ${content}`);
  }
  return parts.join('\n\n');
}

/**
 * Format the model name from "provider/model-name" to something readable.
 * e.g. "anthropic/claude-sonnet-4-5-20250929" → "claude-sonnet-4-5-20250929"
 */
function shortModelName(providerModel: string): string {
  const slashIdx = providerModel.indexOf('/');
  return slashIdx >= 0 ? providerModel.slice(slashIdx + 1) : providerModel;
}

export interface SynthesizerMessages {
  systemPrompt: string;
  userMessage: string;
}

/**
 * Build the synthesizer prompt. Pure function.
 *
 * @param originalMessages - The original /chat/completions messages from the client
 * @param panelResults - Array of panel results with model name and content
 * @returns The system prompt and user message for the synthesizer call
 */
export function buildSynthesizerMessages(
  originalMessages: any[],
  panelResults: PanelResult[],
): SynthesizerMessages {
  const userMessagesFormatted = formatUserMessages(originalMessages);

  const modelResponsesSection = panelResults
    .map((result, i) => {
      const modelName = shortModelName(result.model);
      return `[Response ${i + 1} — ${modelName}]\n${result.content}`;
    })
    .join('\n\n');

  const userMessage = `<original_conversation>
${userMessagesFormatted}
</original_conversation>

---

<model_responses>

${modelResponsesSection}

</model_responses>`;

  return {
    systemPrompt: SYNTHESIZER_SYSTEM_PROMPT,
    userMessage,
  };
}

/**
 * Build the synthesizer messages array for /chat/completions format.
 * Used when passing to OpenAI-compat providers.
 */
export function buildSynthesizerChatMessages(
  originalMessages: any[],
  panelResults: PanelResult[],
): any[] {
  const { systemPrompt, userMessage } = buildSynthesizerMessages(originalMessages, panelResults);
  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userMessage },
  ];
}
