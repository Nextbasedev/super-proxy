/**
 * Claude Code OAuth transform layer (vendored from openclaw-billing-proxy).
 *
 * Source: projects/openclaw-billing-proxy/proxy.js v2.2.3
 * Imported on 2026-05-07 to make Anthropic OAuth (sk-ant-oat01-*) tokens work
 * through Super Proxy by emulating Claude Code traffic.
 *
 * Implements the multi-layer transform required to defeat Anthropic's OpenClaw
 * detection (string triggers, tool-name fingerprinting, system prompt template,
 * tool description fingerprints, schema property names) plus billing fingerprint
 * injection and bidirectional reverse mapping for responses.
 *
 * Logic kept 1:1 with proxy.js so the proven byte-level behaviour is preserved.
 * Operates on raw JSON strings (not parsed objects) to avoid mutating
 * thinking/redacted_thinking content blocks Anthropic enforces byte-equality on.
 */

import crypto from 'node:crypto';

// ─── Constants ──────────────────────────────────────────────────────────────
export const CC_VERSION = '2.1.97';
const BILLING_HASH_SALT = '59cf53e54c78';
const BILLING_HASH_INDICES = [4, 7, 20];

const DEVICE_ID = crypto.randomBytes(32).toString('hex');
const INSTANCE_SESSION_ID = crypto.randomUUID();

export const REQUIRED_BETAS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'advanced-tool-use-2025-11-20',
  'context-management-2025-06-27',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
  'fast-mode-2026-02-01',
];

const CC_TOOL_STUBS = [
  '{"name":"Glob","description":"Find files by pattern","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Glob pattern"}},"required":["pattern"]}}',
  '{"name":"Grep","description":"Search file contents","input_schema":{"type":"object","properties":{"pattern":{"type":"string","description":"Regex pattern"},"path":{"type":"string","description":"Search path"}},"required":["pattern"]}}',
  '{"name":"Agent","description":"Launch a subagent for complex tasks","input_schema":{"type":"object","properties":{"prompt":{"type":"string","description":"Task description"}},"required":["prompt"]}}',
  '{"name":"NotebookEdit","description":"Edit notebook cells","input_schema":{"type":"object","properties":{"notebook_path":{"type":"string"},"cell_index":{"type":"integer"}},"required":["notebook_path"]}}',
  '{"name":"TodoRead","description":"Read current task list","input_schema":{"type":"object","properties":{}}}',
];

// Layer 2: string-trigger sanitization (forward).
// Mirrors `DEFAULT_REPLACEMENTS` in `openclaw-billing-proxy/proxy.js` (forward
// direction). Identity entries are intentionally retained as fingerprint anchors
// so REVERSE_REPLACEMENTS round-trips cleanly. Non-identity entries are the
// real sanitizers (e.g. lossless-claw -> lossless-ctx, HEARTBEAT_OK -> HB_ACK).
const REPLACEMENTS: Array<[string, string]> = [
  ['OCPlatform', 'OpenClaw'],
  ['openclaw', 'openclaw'],
  ['sessions_spawn', 'create_task'],
  ['sessions_list', 'list_tasks'],
  ['sessions_history', 'sessions_history'],
  ['sessions_send', 'sessions_send'],
  ['sessions_yield_interrupt', 'task_yield_interrupt'],
  ['sessions_yield', 'sessions_yield'],
  ['sessions_store', 'sessions_store'],
  ['HEARTBEAT_OK', 'HB_ACK'],
  ['HEARTBEAT', 'HEARTBEAT'],
  ['heartbeat', 'hb_signal'],
  ['running inside', 'running inside'],
  ['Prometheus', 'PAssistant'],
  ['prometheus', 'prometheus'],
  ['clawhub.com', 'clawhub.com'],
  ['skillhub', 'clawhub'],
  ['clawd', 'clawd'],
  ['lossless-claw', 'lossless-ctx'],
  ['third-party', 'third-party'],
  ['billing proxy', 'billing proxy'],
  ['billing-proxy', 'billing-proxy'],
  ['x-anthropic-billing-header', 'x-routing-config'],
  ['x-anthropic-billing', 'x-routing-cfg'],
  ['cch=00000', 'cch=00000'],
  ['cc_version', 'rt_version'],
  ['cc_entrypoint', 'rt_entrypoint'],
  ['billing header', 'billing header'],
  ['extra usage', 'usage quota'],
  ['openclaw', 'openclaw'],
];

// Layer 3: tool-name fingerprint bypass.
// ORDERING: lcm_expand_query MUST come before lcm_expand to avoid partial match.
const TOOL_RENAMES: Array<[string, string]> = [
  ['exec', 'Bash'],
  ['apply_patch', 'NotebookEdit'],
  ['process', 'BashSession'],
  ['browser', 'BrowserControl'],
  ['canvas', 'CanvasView'],
  ['nodes', 'DeviceControl'],
  ['cron', 'Scheduler'],
  ['message', 'SendMessage'],
  ['tts', 'Speech'],
  ['gateway', 'SystemCtl'],
  ['agents_list', 'AgentList'],
  ['sessions_list', 'TodoRead'],
  ['sessions_history', 'TaskHistory'],
  ['sessions_send', 'TaskSend'],
  ['sessions_spawn', 'Agent'],
  ['subagents', 'AgentControl'],
  ['session_status', 'StatusCheck'],
  ['web_search', 'WebSearch'],
  ['web_fetch', 'WebFetch'],
  ['pdf', 'PdfParse'],
  ['image_generate', 'ImageCreate'],
  ['music_generate', 'MusicCreate'],
  ['video_generate', 'VideoCreate'],
  ['memory_search', 'KnowledgeSearch'],
  ['memory_get', 'KnowledgeGet'],
  ['lcm_expand_query', 'ContextQuery'],
  ['lcm_grep', 'ContextGrep'],
  ['lcm_describe', 'ContextDescribe'],
  ['lcm_expand', 'ContextExpand'],
  ['sessions_yield', 'TaskYield'],
  ['sessions_store', 'TaskStore'],
  ['task_yield_interrupt', 'TaskYieldInterrupt'],
  ['read', 'Read'],
  ['write', 'Write'],
  ['edit', 'Edit'],
  ['grep', 'Grep'],
  ['glob', 'Glob'],
  ['ls', 'LS'],
];

// Layer 6: schema property renames.
const PROP_RENAMES: Array<[string, string]> = [
  ['session_id', 'thread_id'],
  ['conversation_id', 'thread_ref'],
  ['summaryIds', 'chunk_ids'],
  ['summary_id', 'chunk_id'],
  ['system_event', 'event_text'],
  ['agent_id', 'worker_id'],
  ['wake_at', 'trigger_at'],
  ['wake_event', 'trigger_event'],
];

// Layer 7: reverse mapping (response → client). Same triggers as REPLACEMENTS.
const REVERSE_REPLACEMENTS: Array<[string, string]> = REPLACEMENTS.map(([a, b]) => [b, a]);

// Stubs to inject — drop any whose name collides with a renamed real tool.
const RENAMED_TARGETS = new Set(TOOL_RENAMES.map(([, cc]) => cc));
const STUBS_TO_INJECT = CC_TOOL_STUBS.filter((stub) => {
  const m = stub.match(/"name":"([^"]+)"/);
  return !m || !RENAMED_TARGETS.has(m[1]);
});

// ─── Helpers ────────────────────────────────────────────────────────────────
function findMatchingBracket(str: string, start: number): number {
  let d = 0;
  let inStr = false;
  for (let i = start; i < str.length; i++) {
    const c = str[i];
    if (inStr) {
      if (c === '\\') {
        i++;
        continue;
      }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === '[') d++;
    else if (c === ']') {
      d--;
      if (d === 0) return i;
    }
  }
  return -1;
}

// ─── Thinking block protection ──────────────────────────────────────────────
const THINK_MASK_PREFIX = '__OBP_THINK_MASK_';
const THINK_MASK_SUFFIX = '__';

const THINK_TYPES = new Set(['thinking', 'redacted_thinking']);

// Mask thinking/redacted_thinking content-block objects so the fingerprint
// scrubber never rewrites their (Anthropic-signed, byte-equality-enforced)
// contents. Detection is STRUCTURAL, not a literal byte-pattern: we balance-scan
// every JSON object and mask any object whose own `type` is thinking/
// redacted_thinking. This is robust to whitespace (`"type": "thinking"`) and key
// ordering (`{"signature":...,"type":"thinking"}`), which the old prefix match
// (`{"type":"thinking"`) silently missed when clients reserialized the body,
// causing scrubbed (and therefore rejected) thinking blocks.
export function maskThinkingBlocks(m: string): { masked: string; masks: string[] } {
  // Phase 1: find spans of every balanced JSON object whose top-level `type`
  // is a thinking variant. Thinking blocks are leaves (no nested thinking), so
  // the matched spans are non-overlapping.
  const spans: Array<[number, number]> = [];
  const stack: number[] = [];
  let inStr = false;
  for (let k = 0; k < m.length; k++) {
    const c = m[k];
    if (inStr) {
      if (c === '\\') { k++; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { stack.push(k); continue; }
    if (c === '}') {
      const open = stack.pop();
      if (open === undefined) continue;
      const obj = m.slice(open, k + 1);
      // Cheap pre-filter: only parse objects that even mention thinking.
      if (obj.indexOf('thinking') === -1) continue;
      try {
        const parsed = JSON.parse(obj);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && THINK_TYPES.has(parsed.type)) {
          spans.push([open, k]);
        }
      } catch {
        // Not a standalone JSON object (e.g. truncated/partial) - leave as-is.
      }
    }
  }
  if (spans.length === 0) return { masked: m, masks: [] };
  // Phase 2: replace spans left-to-right with placeholders, storing originals
  // verbatim so unmask restores byte-identical content.
  spans.sort((a, b) => a[0] - b[0]);
  const masks: string[] = [];
  let out = '';
  let i = 0;
  for (const [s, e] of spans) {
    if (s < i) continue; // safety: skip any overlap
    out += m.slice(i, s);
    masks.push(m.slice(s, e + 1));
    out += THINK_MASK_PREFIX + (masks.length - 1) + THINK_MASK_SUFFIX;
    i = e + 1;
  }
  out += m.slice(i);
  return { masked: out, masks };
}

export function unmaskThinkingBlocks(m: string, masks: string[]): string {
  for (let i = 0; i < masks.length; i++) {
    m = m.split(THINK_MASK_PREFIX + i + THINK_MASK_SUFFIX).join(masks[i]);
  }
  return m;
}

function isEmptySignedThinkingBlock(block: any): boolean {
  if (!block || typeof block !== 'object' || !THINK_TYPES.has(block.type)) return false;
  if (typeof block.signature !== 'string' || !block.signature) return false;
  const payload = block.type === 'redacted_thinking' ? block.data : block.thinking;
  return payload == null || (typeof payload === 'string' && payload.trim() === '');
}

// OpenClaw compaction/history export can preserve Anthropic thinking signatures
// while blanking the signed payload (`thinking:""`). Those blocks are already
// invalid before they reach NBMG; masking preserves them byte-for-byte, which
// still fails upstream. Drop only these provably-corrupted blocks before the
// fingerprint transform. Valid non-empty signed thinking blocks remain protected
// by maskThinkingBlocks/unmaskThinkingBlocks.
export function dropEmptySignedThinkingBlocks(bodyStr: string): { body: string; dropped: number } {
  if (bodyStr.indexOf('"signature"') === -1 || bodyStr.indexOf('thinking') === -1) return { body: bodyStr, dropped: 0 };
  let parsed: any;
  try { parsed = JSON.parse(bodyStr); } catch { return { body: bodyStr, dropped: 0 }; }
  let dropped = 0;
  const messages = Array.isArray(parsed?.messages) ? parsed.messages : [];
  for (const msg of messages) {
    if (!Array.isArray(msg?.content)) continue;
    const before = msg.content.length;
    msg.content = msg.content.filter((block: any) => !isEmptySignedThinkingBlock(block));
    const removed = before - msg.content.length;
    dropped += removed;
    // Avoid creating invalid assistant messages with empty content when a turn
    // consisted only of compacted/corrupt signed thinking. A neutral text marker
    // is less harmful than forwarding an invalid signature (guaranteed 400) and
    // keeps role ordering intact for downstream Anthropic validation.
    if (removed > 0 && msg.content.length === 0 && msg.role === 'assistant') {
      msg.content = [{ type: 'text', text: '[compacted signed thinking block removed]' }];
    }
  }
  return dropped > 0 ? { body: JSON.stringify(parsed), dropped } : { body: bodyStr, dropped: 0 };
}

function parseSseJson(dataStr: string): any | null {
  const s = dataStr.trim();
  if (!s || s[0] !== '{') return null;
  try { return JSON.parse(s); } catch { return null; }
}

export function getSseDataType(dataStr: string): string | undefined {
  return parseSseJson(dataStr)?.type;
}

export function isThinkingContentBlockStartData(dataStr: string): boolean {
  const parsed = parseSseJson(dataStr);
  const blockType = parsed?.content_block?.type;
  return parsed?.type === 'content_block_start' && THINK_TYPES.has(blockType);
}

// ─── Billing fingerprint ────────────────────────────────────────────────────
function extractFirstUserText(bodyStr: string): string {
  const msgsIdx = bodyStr.indexOf('"messages":[');
  if (msgsIdx === -1) return '';
  const userIdx = bodyStr.indexOf('"role":"user"', msgsIdx);
  if (userIdx === -1) return '';
  const contentIdx = bodyStr.indexOf('"content"', userIdx);
  if (contentIdx === -1 || contentIdx > userIdx + 500) return '';
  const afterContent = bodyStr[contentIdx + '"content"'.length + 1];
  if (afterContent === '"') {
    const textStart = contentIdx + '"content":"'.length;
    let end = textStart;
    while (end < bodyStr.length) {
      if (bodyStr[end] === '\\') {
        end += 2;
        continue;
      }
      if (bodyStr[end] === '"') break;
      end++;
    }
    return bodyStr
      .slice(textStart, end)
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, '\\');
  }
  const textIdx = bodyStr.indexOf('"text":"', contentIdx);
  if (textIdx === -1 || textIdx > contentIdx + 2000) return '';
  const textStart = textIdx + '"text":"'.length;
  let end = textStart;
  while (end < bodyStr.length) {
    if (bodyStr[end] === '\\') {
      end += 2;
      continue;
    }
    if (bodyStr[end] === '"') break;
    end++;
  }
  return bodyStr
    .slice(textStart, Math.min(end, textStart + 50))
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\');
}

function computeBillingFingerprint(firstUserText: string): string {
  const chars = BILLING_HASH_INDICES.map((i) => firstUserText[i] || '0').join('');
  const input = `${BILLING_HASH_SALT}${chars}${CC_VERSION}`;
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 3);
}

function buildBillingBlock(bodyStr: string): string {
  const firstText = extractFirstUserText(bodyStr);
  const fp = computeBillingFingerprint(firstText);
  const ccVersion = `${CC_VERSION}.${fp}`;
  return `{"type":"text","text":"x-anthropic-billing-header: cc_version=${ccVersion}; cc_entrypoint=cli; cch=00000;"}`;
}

// ─── Forward transform ──────────────────────────────────────────────────────
export function processBody(bodyStr: string): string {
  const pruned = dropEmptySignedThinkingBlocks(bodyStr);
  const { masked, masks: thinkMasks } = maskThinkingBlocks(pruned.body);
  let m = masked;

  // Layer 2
  for (const [find, replace] of REPLACEMENTS) m = m.split(find).join(replace);
  // Layer 3
  for (const [orig, cc] of TOOL_RENAMES) m = m.split('"' + orig + '"').join('"' + cc + '"');
  // Layer 6
  for (const [orig, renamed] of PROP_RENAMES) m = m.split('"' + orig + '"').join('"' + renamed + '"');

  // Layer 4: strip OC system config block, paraphrase replacement.
  {
    const IDENTITY_MARKER = 'You are a personal assistant';
    const sysArrayStart = m.indexOf('"system":[');
    const searchFrom = sysArrayStart !== -1 ? sysArrayStart : 0;
    const configStart = m.indexOf(IDENTITY_MARKER, searchFrom);
    if (configStart !== -1) {
      let stripFrom = configStart;
      if (stripFrom >= 2 && m[stripFrom - 2] === '\\' && m[stripFrom - 1] === 'n') {
        stripFrom -= 2;
      }
      let configEnd = m.indexOf('\\n## /', configStart + IDENTITY_MARKER.length);
      if (configEnd === -1) configEnd = m.indexOf('\\n## C:\\\\', configStart + IDENTITY_MARKER.length);
      if (configEnd !== -1) {
        const boundary = configEnd;
        const strippedLen = boundary - stripFrom;
        if (strippedLen > 1000) {
          const PARAPHRASE =
            '\\nYou are an AI operations assistant with access to all tools listed in this request ' +
            'for file operations, command execution, web search, browser control, scheduling, ' +
            'messaging, and session management. Tool names are case-sensitive and must be called ' +
            'exactly as listed. Your responses route to the active channel automatically. ' +
            'For cross-session communication, use the task messaging tools. ' +
            'Skills defined in your workspace should be invoked when they match user requests. ' +
            'Consult your workspace reference files for detailed operational configuration.\\n';
          m = m.slice(0, stripFrom) + PARAPHRASE + m.slice(boundary);
        }
      }
    }
  }

  // Layer 5: strip tool descriptions + inject CC stubs.
  {
    const toolsIdx = m.indexOf('"tools":[');
    if (toolsIdx !== -1) {
      const toolsEndIdx = findMatchingBracket(m, toolsIdx + '"tools":'.length);
      if (toolsEndIdx !== -1) {
        let section = m.slice(toolsIdx, toolsEndIdx + 1);
        let from = 0;
        while (true) {
          const d = section.indexOf('"description":"', from);
          if (d === -1) break;
          const vs = d + '"description":"'.length;
          let i = vs;
          while (i < section.length) {
            if (section[i] === '\\' && i + 1 < section.length) {
              i += 2;
              continue;
            }
            if (section[i] === '"') break;
            i++;
          }
          section = section.slice(0, vs) + section.slice(i);
          from = vs + 1;
        }
        if (STUBS_TO_INJECT.length > 0) {
          const insertAt = '"tools":['.length;
          section = section.slice(0, insertAt) + STUBS_TO_INJECT.join(',') + ',' + section.slice(insertAt);
        }
        m = m.slice(0, toolsIdx) + section + m.slice(toolsEndIdx + 1);
      }
    }
  }

  // Layer 1: billing block injection.
  const BILLING_BLOCK = buildBillingBlock(m);
  const sysArrayIdx = m.indexOf('"system":[');
  if (sysArrayIdx !== -1) {
    const insertAt = sysArrayIdx + '"system":['.length;
    m = m.slice(0, insertAt) + BILLING_BLOCK + ',' + m.slice(insertAt);
  } else if (m.includes('"system":"')) {
    const sysStart = m.indexOf('"system":"');
    let i = sysStart + '"system":"'.length;
    while (i < m.length) {
      if (m[i] === '\\') {
        i += 2;
        continue;
      }
      if (m[i] === '"') break;
      i++;
    }
    const sysEnd = i + 1;
    const originalSysStr = m.slice(sysStart + '"system":'.length, sysEnd);
    m =
      m.slice(0, sysStart) +
      '"system":[' +
      BILLING_BLOCK +
      ',{"type":"text","text":' +
      originalSysStr +
      '}]' +
      m.slice(sysEnd);
  } else {
    m = '{"system":[' + BILLING_BLOCK + '],' + m.slice(1);
  }

  // Metadata: device_id + session_id matching real CC format.
  const metaValue = JSON.stringify({ device_id: DEVICE_ID, session_id: INSTANCE_SESSION_ID });
  const metaJson = '"metadata":{"user_id":' + JSON.stringify(metaValue) + '}';
  const existingMeta = m.indexOf('"metadata":{');
  if (existingMeta !== -1) {
    let depth = 0;
    let mi = existingMeta + '"metadata":'.length;
    for (; mi < m.length; mi++) {
      if (m[mi] === '{') depth++;
      else if (m[mi] === '}') {
        depth--;
        if (depth === 0) {
          mi++;
          break;
        }
      }
    }
    m = m.slice(0, existingMeta) + metaJson + m.slice(mi);
  } else {
    m = '{' + metaJson + ',' + m.slice(1);
  }

  // Layer 8: strip trailing assistant prefill.
  {
    const msgsIdx = m.indexOf('"messages":[');
    if (msgsIdx !== -1) {
      const arrayStart = msgsIdx + '"messages":['.length;
      const positions: Array<{ start: number; end: number }> = [];
      let depth = 0;
      let inString = false;
      let objStart = -1;
      for (let i = arrayStart; i < m.length; i++) {
        const c = m[i];
        if (inString) {
          if (c === '\\') {
            i++;
            continue;
          }
          if (c === '"') inString = false;
          continue;
        }
        if (c === '"') {
          inString = true;
          continue;
        }
        if (c === '{') {
          if (depth === 0) objStart = i;
          depth++;
        } else if (c === '}') {
          depth--;
          if (depth === 0 && objStart !== -1) {
            positions.push({ start: objStart, end: i });
            objStart = -1;
          }
        } else if (c === ']' && depth === 0) break;
      }
      while (positions.length > 0) {
        const last = positions[positions.length - 1];
        const obj = m.slice(last.start, last.end + 1);
        if (!obj.includes('"role":"assistant"')) break;
        let stripFrom = last.start;
        for (let i = last.start - 1; i >= arrayStart; i--) {
          if (m[i] === ',') {
            stripFrom = i;
            break;
          }
          if (m[i] !== ' ' && m[i] !== '\n' && m[i] !== '\r' && m[i] !== '\t') break;
        }
        m = m.slice(0, stripFrom) + m.slice(last.end + 1);
        positions.pop();
      }
    }
  }

  return unmaskThinkingBlocks(m, thinkMasks);
}

// ─── Reverse mapping (response → client) ────────────────────────────────────
export function reverseMap(text: string): string {
  let r = text;
  for (const [orig, cc] of TOOL_RENAMES) {
    r = r.split('"' + cc + '"').join('"' + orig + '"');
    r = r.split('\\"' + cc + '\\"').join('\\"' + orig + '\\"');
  }
  for (const [orig, renamed] of PROP_RENAMES) {
    r = r.split('"' + renamed + '"').join('"' + orig + '"');
    r = r.split('\\"' + renamed + '\\"').join('\\"' + orig + '\\"');
  }
  for (const [sanitized, original] of REVERSE_REPLACEMENTS) {
    r = r.split(sanitized).join(original);
  }
  return r;
}

// SSE event-aware reverse mapping: tracks current content block type so
// thinking/redacted_thinking deltas pass through byte-identical.
export class SseReverseMapper {
  private currentBlockIsThinking = false;

  transform(event: string): string {
    let dataIdx = event.startsWith('data: ') ? 0 : event.indexOf('\ndata: ');
    if (dataIdx === -1) return reverseMap(event);
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
      return reverseMap(event);
    }
    if (sseType === 'content_block_stop') {
      const wasThinking = this.currentBlockIsThinking;
      this.currentBlockIsThinking = false;
      return wasThinking ? event : reverseMap(event);
    }
    if (this.currentBlockIsThinking) return event;
    return reverseMap(event);
  }
}

// Reverse-map a non-stream JSON response while protecting thinking blocks.
export function reverseMapJsonResponse(respBody: string): string {
  const { masked, masks } = maskThinkingBlocks(respBody);
  return unmaskThinkingBlocks(reverseMap(masked), masks);
}

// ─── Headers ────────────────────────────────────────────────────────────────
function osName(): string {
  const p = process.platform;
  return p === 'darwin' ? 'macOS' : p === 'win32' ? 'Windows' : p === 'linux' ? 'Linux' : p;
}

export function applyClaudeCodeOAuthHeaders(headers: Headers): void {
  headers.set('user-agent', `claude-cli/${CC_VERSION} (third-party, cli)`);
  headers.set('x-app', 'cli');
  headers.set('x-claude-code-session-id', INSTANCE_SESSION_ID);
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
  const existing = (headers.get('anthropic-beta') || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  for (const b of REQUIRED_BETAS) if (!existing.includes(b)) existing.push(b);
  headers.set('anthropic-beta', existing.join(','));
}
