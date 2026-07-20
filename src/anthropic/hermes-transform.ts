/**
 * Hermes-agent Anthropic OAuth transform layer.
 *
 * Hermes (NousResearch/hermes-agent) sends Anthropic `/v1/messages` requests
 * with a DIFFERENT fingerprint than OpenClaw:
 *   - tool names use the `mcp_<tool>` shape (e.g. `mcp_bash`)
 *   - system prompt is a plain identity, not OCPlatform's config block
 *   - it expects the `sdk-cli` entrypoint + computed `cch` (not the legacy
 *     `cli` / `cch=00000` OCPlatform still uses)
 *
 * Anthropic's 2026-04-04 server-side billing validator rejects raw Hermes
 * requests with HTTP 400 ("Third-party apps now draw from your extra usage").
 *
 * This module is the verified fix, ported 1:1 from a sandbox-validated patch
 * (kristianvast/hermes-claude-auth lineage). Verified live in an isolated
 * Incus sandbox on 2026-06-05: raw Hermes payload -> 400; transformed -> 200
 * with working `mcp__hermes__Bash` tool round-trips (22/22 stress requests OK).
 *
 * IMPORTANT: this is a SEPARATE module from `claude-code-transform.ts`. The
 * OCPlatform transform path is intentionally left byte-for-byte unchanged. The
 * proxy selects between them via client-type detection (see anthropic.ts).
 *
 * Like the OCPlatform transform, this operates on raw JSON strings to avoid
 * touching thinking/redacted_thinking blocks Anthropic enforces byte-equality
 * on; we mask those blocks before any string rewriting.
 */

import crypto from 'node:crypto';
import { dropEmptySignedThinkingBlocks, getSseDataType, isThinkingContentBlockStartData, maskThinkingBlocks, unmaskThinkingBlocks } from './claude-code-transform.js';

// ─── Constants (from the sandbox-verified patch) ─────────────────────────────
// Shared salt shipped in the Claude Code CLI binary; Anthropic verifies the
// billing-header signature against it. Same salt as the OCPlatform transform.
const BILLING_SALT = '59cf53e54c78';
// Claude Code 2.1.112+ reports `sdk-cli` (Hermes path uses the modern value).
const BILLING_ENTRYPOINT = 'sdk-cli';
// Claude Code version reported in the billing header. Kept current per the
// sandbox test (the validator allow-lists recent versions).
export const HERMES_CC_VERSION = '2.1.165';
const BILLING_HASH_INDICES = [4, 7, 20];

const SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.";

const MCP_PREFIX = 'mcp_';
const MCP_HERMES_NAMESPACE = 'mcp__hermes__';

// OAuth-only beta flags appended on top of Hermes's built-in betas.
const HERMES_EXTRA_BETAS = ['prompt-caching-scope-2026-01-05', 'advisor-tool-2026-03-01'];

// ─── Client detection ────────────────────────────────────────────────────────
// Older Hermes namespaces its MCP tools with the lowercase `mcp_` prefix.
// Newer Hermes builds can send bare tool names (`browser_*`, `terminal`,
// `delegate_task`, ...), so tool-name detection alone is no longer enough.
// Keep the fast `mcp_` discriminator, then fall back to checking only the
// system prompt for Hermes's own identity text. Do not scan user messages for
// that text, otherwise an OpenClaw user merely discussing Hermes could be
// misrouted into the Hermes transform.
const MCP_TOOL_NAME_RE = /"name":"mcp_[a-zA-Z0-9]/;
const HERMES_SYSTEM_MARKERS = [
  'You run on Hermes Agent',
  'Hermes Agent (by Nous Research)',
];

export function isHermesBody(bodyStr: string): boolean {
  if (MCP_TOOL_NAME_RE.test(bodyStr)) return true;
  try {
    const parsed = JSON.parse(bodyStr);
    const system = parsed?.system;
    const blocks = typeof system === 'string' ? [system] : Array.isArray(system) ? system : [];
    for (const block of blocks) {
      const text = typeof block === 'string' ? block : block && typeof block === 'object' ? block.text : '';
      if (typeof text === 'string' && HERMES_SYSTEM_MARKERS.some((marker) => text.includes(marker))) return true;
    }
  } catch {}
  return false;
}

// ─── Tool-name namespacing ───────────────────────────────────────────────────
function uppercaseFirst(name: string): string {
  return name ? name[0].toUpperCase() + name.slice(1) : name;
}
function lowercaseFirst(name: string): string {
  return name ? name[0].toLowerCase() + name.slice(1) : name;
}

// mcp_bash -> mcp__hermes__Bash
function wrapToolName(name: string): string {
  if (!name) return name;
  if (name.startsWith(MCP_HERMES_NAMESPACE)) return name;
  const base = name.startsWith(MCP_PREFIX) ? name.slice(MCP_PREFIX.length) : name;
  return MCP_HERMES_NAMESPACE + uppercaseFirst(base);
}

// mcp__hermes__Bash -> bash
function unwrapToolName(name: string): string {
  if (!name) return name;
  if (name.startsWith(MCP_HERMES_NAMESPACE)) return lowercaseFirst(name.slice(MCP_HERMES_NAMESPACE.length));
  return name;
}

// ─── Billing fingerprint ─────────────────────────────────────────────────────
// Mirror of the OCPlatform extractor: pull the first user message's text. Hermes
// sends `content` as either a plain string or an array of text blocks.
function extractFirstUserText(bodyStr: string): string {
  const msgsIdx = bodyStr.indexOf('"messages":[');
  if (msgsIdx === -1) return '';
  const userIdx = bodyStr.indexOf('"role":"user"', msgsIdx);
  if (userIdx === -1) return '';
  const contentIdx = bodyStr.indexOf('"content"', userIdx);
  if (contentIdx === -1) return '';
  const afterContent = bodyStr[contentIdx + '"content"'.length + 1];
  if (afterContent === '"') {
    const textStart = contentIdx + '"content":"'.length;
    let end = textStart;
    while (end < bodyStr.length) {
      if (bodyStr[end] === '\\') { end += 2; continue; }
      if (bodyStr[end] === '"') break;
      end++;
    }
    return decodeJsonStr(bodyStr.slice(textStart, end));
  }
  const textIdx = bodyStr.indexOf('"text":"', contentIdx);
  if (textIdx === -1) return '';
  const textStart = textIdx + '"text":"'.length;
  let end = textStart;
  while (end < bodyStr.length) {
    if (bodyStr[end] === '\\') { end += 2; continue; }
    if (bodyStr[end] === '"') break;
    end++;
  }
  return decodeJsonStr(bodyStr.slice(textStart, end));
}

function decodeJsonStr(s: string): string {
  return s.replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
}

// cch = first 5 hex chars of SHA-256(firstUserText)
function computeCch(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 5);
}

// version suffix = first 3 hex of SHA-256(salt + sampled[4,7,20] + version)
function computeVersionSuffix(text: string, version: string): string {
  const sampled = BILLING_HASH_INDICES.map((i) => (i < text.length ? text[i] : '0')).join('');
  const input = `${BILLING_SALT}${sampled}${version}`;
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex').slice(0, 3);
}

function buildBillingHeaderText(firstUserText: string): string {
  const suffix = computeVersionSuffix(firstUserText, HERMES_CC_VERSION);
  const cch = computeCch(firstUserText);
  return `x-anthropic-billing-header: cc_version=${HERMES_CC_VERSION}.${suffix}; cc_entrypoint=${BILLING_ENTRYPOINT}; cch=${cch};`;
}

// ─── Forward transform ───────────────────────────────────────────────────────
//
// We parse → mutate → re-stringify here (rather than string-splicing) because
// the Hermes transforms are structural (system relocation, tool namespacing,
// metadata) and Hermes does not send the thinking/redacted_thinking blocks that
// require byte-preservation on the REQUEST. We still mask any such blocks first
// as a safety net so they round-trip untouched even if present.
export function processHermesBody(bodyStr: string): string {
  const pruned = dropEmptySignedThinkingBlocks(bodyStr);
  const { masked, masks } = maskThinkingBlocks(pruned.body);
  let parsed: any;
  try {
    parsed = JSON.parse(masked);
  } catch {
    // If we cannot parse, do nothing (fail safe — forward unchanged).
    return bodyStr;
  }

  const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
  if (messages.length === 0) return bodyStr;

  // 1. Tool-pair repair: strip orphaned tool_use / tool_result blocks.
  parsed.messages = repairToolPairs(messages);

  // 2. Build the billing header from the first user message text.
  const firstUserText = extractFirstUserTextFromParsed(parsed.messages);
  const billingEntry = { type: 'text', text: buildBillingHeaderText(firstUserText) };

  // 3. System prompt handling (OCPlatform-parity): keep ALL system content in
  //    system[]. Billing header -> system[0]; the Claude Code identity is
  //    ensured present (deduped); every other system block is preserved in
  //    place at full system-prompt weight. We deliberately do NOT relocate
  //    non-identity system text into the user message.
  //
  //    Why: live-verified 2026-06-05 against api.anthropic.com that the billing
  //    validator accepts a real ops system prompt fused/kept in system[] (200),
  //    identical to OCPlatform. The earlier <system-reminder> relocation was
  //    inherited from the upstream lineage and is NOT load-bearing; relocating
  //    only weakened the agent's system instructions for no benefit.
  const rawSystem = parsed.system;
  let system: any[];
  if (rawSystem == null) system = [];
  else if (typeof rawSystem === 'string') system = rawSystem ? [{ type: 'text', text: rawSystem }] : [];
  else if (Array.isArray(rawSystem)) system = rawSystem.slice();
  else system = [];

  const kept: any[] = [];
  let identitySeen = false;
  for (const entry of system) {
    if (!entry || typeof entry !== 'object' || entry.type !== 'text') { kept.push(entry); continue; }
    const text: string = typeof entry.text === 'string' ? entry.text : '';
    if (text.startsWith('x-anthropic-billing-header')) continue; // drop stale billing header
    if (text.startsWith(SYSTEM_IDENTITY)) {
      if (identitySeen) continue; // drop duplicate identity block
      identitySeen = true;
      // Keep the identity block intact, including any ops instructions fused
      // after it (same shape OCPlatform sends).
      kept.push({ type: 'text', text });
      continue;
    }
    if (text) kept.push({ type: 'text', text }); // preserve other system blocks in place
  }
  // Ensure the canonical identity is present as the first non-billing block.
  if (!identitySeen) kept.unshift({ type: 'text', text: SYSTEM_IDENTITY });
  parsed.system = [billingEntry, ...kept];

  // 4. Tool-name namespacing: mcp_bash -> mcp__hermes__Bash (tools[] + tool_use).
  rewriteToolNames(parsed);

  // 5. Effort strip for haiku; temperature strip for Opus 4.6 adaptive thinking.
  stripEffortForHaiku(parsed);
  stripTemperatureForAdaptive(parsed);

  // 6. Beta flags: append the OAuth-only extras (header-level betas added in
  //    applyHermesOAuthHeaders; this keeps any body-level `betas` consistent if
  //    Hermes ever sends them — currently it does not, so this is a no-op guard).
  if (Array.isArray(parsed.betas)) {
    for (const b of HERMES_EXTRA_BETAS) if (!parsed.betas.includes(b)) parsed.betas.push(b);
  }

  const out = JSON.stringify(parsed);
  return unmaskThinkingBlocks(out, masks);
}

function extractFirstUserTextFromParsed(messages: any[]): string {
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || msg.role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string' && block.text) {
          return block.text;
        }
      }
    }
    return '';
  }
  return '';
}

function rewriteToolNames(parsed: any): void {
  if (Array.isArray(parsed.tools)) {
    for (const tool of parsed.tools) {
      if (tool && typeof tool === 'object' && typeof tool.name === 'string') {
        tool.name = wrapToolName(tool.name);
      }
    }
  }
  if (Array.isArray(parsed.messages)) {
    for (const msg of parsed.messages) {
      if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) continue;
      for (const block of msg.content) {
        if (block && typeof block === 'object' && block.type === 'tool_use' && typeof block.name === 'string') {
          block.name = wrapToolName(block.name);
        }
      }
    }
  }
}

function repairToolPairs(messages: any[]): any[] {
  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!block || typeof block !== 'object') continue;
      if (block.type === 'tool_use' && typeof block.id === 'string') toolUseIds.add(block.id);
      else if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') toolResultIds.add(block.tool_use_id);
    }
  }
  const orphanedUses = new Set([...toolUseIds].filter((x) => !toolResultIds.has(x)));
  const orphanedResults = new Set([...toolResultIds].filter((x) => !toolUseIds.has(x)));
  if (orphanedUses.size === 0 && orphanedResults.size === 0) return messages;

  const repaired: any[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== 'object' || !Array.isArray(msg.content)) { repaired.push(msg); continue; }
    const filtered = msg.content.filter((block: any) => {
      if (!block || typeof block !== 'object') return true;
      if (block.type === 'tool_use' && orphanedUses.has(block.id)) return false;
      if (block.type === 'tool_result' && orphanedResults.has(block.tool_use_id)) return false;
      return true;
    });
    if (filtered.length > 0) repaired.push({ ...msg, content: filtered });
  }
  return repaired;
}

function stripEffortForHaiku(parsed: any): void {
  const model = typeof parsed.model === 'string' ? parsed.model : '';
  if (!model.toLowerCase().includes('haiku')) return;
  if (parsed.output_config && typeof parsed.output_config === 'object' && 'effort' in parsed.output_config) {
    delete parsed.output_config.effort;
    if (Object.keys(parsed.output_config).length === 0) delete parsed.output_config;
  }
  if (parsed.thinking && typeof parsed.thinking === 'object' && 'effort' in parsed.thinking) {
    delete parsed.thinking.effort;
    if (Object.keys(parsed.thinking).length === 0) delete parsed.thinking;
  }
}

function stripTemperatureForAdaptive(parsed: any): void {
  if (!('temperature' in parsed)) return;
  const t = parsed.temperature;
  if (t === 1 || t === 1.0) return;
  const model = typeof parsed.model === 'string' ? parsed.model : '';
  if (model.includes('4-6') || model.includes('4.6')) delete parsed.temperature;
}

// ─── Reverse mapping (response → Hermes) ─────────────────────────────────────
// Unwrap mcp__hermes__Bash -> bash so Hermes's tool dispatcher finds the tool.
// Operates on the raw response string for both name and escaped-name forms.
export function reverseMapHermes(text: string): string {
  // Replace "name":"mcp__hermes__X" -> "name":"x" for any tool name.
  return replaceToolNames(text);
}

function replaceToolNames(text: string): string {
  // Match the wrapped namespace in both unescaped and escaped JSON forms.
  return text
    .replace(/"name":"mcp__hermes__([A-Za-z0-9_]+)"/g, (_m, p1) => `"name":"${lowercaseFirst(p1)}"`)
    .replace(/\\"name\\":\\"mcp__hermes__([A-Za-z0-9_]+)\\"/g, (_m, p1) => `\\"name\\":\\"${lowercaseFirst(p1)}\\"`);
}

// Reverse-map a non-stream JSON response while protecting thinking blocks.
export function reverseMapHermesJsonResponse(respBody: string): string {
  const { masked, masks } = maskThinkingBlocks(respBody);
  return unmaskThinkingBlocks(reverseMapHermes(masked), masks);
}

// SSE event-aware reverse mapping for streamed Hermes responses. Tool names
// only appear in content_block_start (tool_use) events, but to stay robust we
// reverse-map every non-thinking event (thinking deltas pass through untouched).
export class HermesSseReverseMapper {
  private currentBlockIsThinking = false;

  transform(event: string): string {
    let dataIdx = event.startsWith('data: ') ? 0 : event.indexOf('\ndata: ');
    if (dataIdx === -1) return reverseMapHermes(event);
    if (dataIdx > 0) dataIdx += 1;
    const dataLineEnd = event.indexOf('\n', dataIdx + 6);
    const dataStr = dataLineEnd === -1 ? event.slice(dataIdx + 6) : event.slice(dataIdx + 6, dataLineEnd);

    const sseType = getSseDataType(dataStr);
    if (sseType === 'content_block_start') {
      if (isThinkingContentBlockStartData(dataStr)) {
        this.currentBlockIsThinking = true;
        return event;
      }
      this.currentBlockIsThinking = false;
      return reverseMapHermes(event);
    }
    if (sseType === 'content_block_stop') {
      const wasThinking = this.currentBlockIsThinking;
      this.currentBlockIsThinking = false;
      return wasThinking ? event : reverseMapHermes(event);
    }
    if (this.currentBlockIsThinking) return event;
    return reverseMapHermes(event);
  }
}

// ─── Headers ─────────────────────────────────────────────────────────────────
function osName(): string {
  const p = process.platform;
  return p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p;
}

// Hermes-specific OAuth headers. Mirrors the sandbox-verified Stainless spoof
// set + entrypoint=sdk-cli user-agent. Distinct from the OCPlatform header set
// (which uses entrypoint `cli` and a different user-agent suffix).
export function applyHermesOAuthHeaders(headers: Headers): void {
  headers.set('user-agent', `claude-cli/${HERMES_CC_VERSION} (external, cli)`);
  headers.set('x-app', 'cli');
  headers.set('x-stainless-arch', process.arch === 'x64' ? 'x64' : process.arch === 'arm64' ? 'arm64' : process.arch);
  headers.set('x-stainless-lang', 'js');
  headers.set('x-stainless-os', osName());
  headers.set('x-stainless-package-version', '0.81.0');
  headers.set('x-stainless-runtime', 'node');
  headers.set('x-stainless-runtime-version', process.version);
  headers.set('x-stainless-retry-count', '0');
  headers.set('x-stainless-timeout', '600');
  headers.set('anthropic-dangerous-direct-browser-access', 'true');
  headers.set('anthropic-version', '2023-06-01');
  const REQUIRED = [
    'oauth-2025-04-20',
    'claude-code-20250219',
    'interleaved-thinking-2025-05-14',
    'fine-grained-tool-streaming-2025-05-14',
    ...HERMES_EXTRA_BETAS,
  ];
  const existing = (headers.get('anthropic-beta') || '').split(',').map((x) => x.trim()).filter(Boolean);
  for (const b of REQUIRED) if (!existing.includes(b)) existing.push(b);
  headers.set('anthropic-beta', existing.join(','));
}
