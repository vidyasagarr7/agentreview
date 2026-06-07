import type {
  TraceEvent,
  TraceEventType,
  TraceSession,
  TraceStats,
  TraceToolCall,
} from './types.js';

const NOISE_TYPES = new Set<string>([
  'permission-mode',
  'file-history-snapshot',
  'attachment',
  'last-prompt',
  'ai-title',
  'summary',
]);

const OK_TRUNCATE = 80;
const ERR_TRUNCATE = 400;

interface RawLine {
  type?: string;
  sessionId?: string;
  uuid?: string;
  timestamp?: string;
  message?: RawMessage;
}

interface RawMessage {
  role?: string;
  model?: string;
  content?: string | RawContentBlock[];
}

interface RawContentBlock {
  type?: string;
  text?: string;
  thinking?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | RawContentBlock[];
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function emptyStats(): TraceStats {
  return {
    totalEvents: 0,
    userPrompts: 0,
    toolCalls: 0,
    toolCallsByName: {},
    errorCount: 0,
    durationMs: null,
  };
}

function emptySession(): TraceSession {
  return {
    sessionId: null,
    model: null,
    startedAt: null,
    endedAt: null,
    events: [],
    stats: emptyStats(),
    warnings: 0,
  };
}

function extractUserText(content: string | RawContentBlock[] | undefined): {
  text: string | undefined;
  toolResults: RawContentBlock[];
} {
  if (content === undefined || content === null) {
    return { text: undefined, toolResults: [] };
  }
  if (typeof content === 'string') {
    return { text: content, toolResults: [] };
  }
  if (!Array.isArray(content)) {
    return { text: undefined, toolResults: [] };
  }

  const parts: string[] = [];
  const toolResults: RawContentBlock[] = [];
  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (block.type === 'tool_result') {
      toolResults.push(block);
    }
  }
  return {
    text: parts.length > 0 ? parts.join('\n') : undefined,
    toolResults,
  };
}

function extractAssistantBlocks(content: RawContentBlock[]): {
  text?: string;
  thinking?: string;
  toolCalls?: TraceToolCall[];
} {
  const textParts: string[] = [];
  const thinkingParts: string[] = [];
  const toolCalls: TraceToolCall[] = [];

  for (const block of content) {
    if (!isPlainObject(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') {
      textParts.push(block.text);
    } else if (block.type === 'thinking' && typeof block.thinking === 'string') {
      thinkingParts.push(block.thinking);
    } else if (block.type === 'tool_use' && typeof block.name === 'string') {
      toolCalls.push({
        id: typeof block.id === 'string' ? block.id : undefined,
        name: block.name,
        input: isPlainObject(block.input) ? block.input : {},
      });
    }
  }

  return {
    text: textParts.length > 0 ? textParts.join('\n') : undefined,
    thinking: thinkingParts.length > 0 ? thinkingParts.join('\n') : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

function flattenToolResultContent(
  content: string | RawContentBlock[] | undefined,
): string {
  if (content === undefined || content === null) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const b of content) {
    if (!isPlainObject(b)) continue;
    if (typeof b.text === 'string') parts.push(b.text);
    else if (typeof b.content === 'string') parts.push(b.content);
  }
  return parts.join('\n');
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + '…';
}

function classifyType(t: string | undefined): TraceEventType | 'noise' {
  if (!t) return 'unknown';
  if (NOISE_TYPES.has(t)) return 'noise';
  if (t === 'user') return 'user';
  if (t === 'assistant') return 'assistant';
  if (t === 'system') return 'system';
  return 'unknown';
}

export function parseTrace(input: string): TraceSession {
  const session = emptySession();

  if (!input || input.length === 0) return session;

  const pendingToolCalls = new Map<string, TraceToolCall>();
  let firstTs: string | null = null;
  let lastTs: string | null = null;

  const lines = input.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let raw: unknown;
    try {
      raw = JSON.parse(line);
    } catch {
      session.warnings++;
      continue;
    }
    if (!isPlainObject(raw)) {
      session.warnings++;
      continue;
    }
    const parsed = raw as RawLine;

    const kind = classifyType(parsed.type);
    if (kind === 'noise') continue;

    if (typeof parsed.sessionId === 'string' && !session.sessionId) {
      session.sessionId = parsed.sessionId;
    }

    const timestamp = typeof parsed.timestamp === 'string' ? parsed.timestamp : '';
    const uuid = typeof parsed.uuid === 'string' ? parsed.uuid : '';

    if (timestamp) {
      if (!firstTs) firstTs = timestamp;
      lastTs = timestamp;
    }

    if (kind === 'user') {
      const msg = parsed.message;
      const { text, toolResults } = extractUserText(msg?.content);

      // Attach tool results to pending tool_use calls.
      for (const tr of toolResults) {
        const toolUseId = tr.tool_use_id;
        const flat = flattenToolResultContent(tr.content);
        const isError = tr.is_error === true;
        const max = isError ? ERR_TRUNCATE : OK_TRUNCATE;
        const truncated = truncate(flat, max);
        if (isError) session.stats.errorCount++;

        if (typeof toolUseId === 'string' && pendingToolCalls.has(toolUseId)) {
          const call = pendingToolCalls.get(toolUseId)!;
          call.result = { content: truncated, isError };
          pendingToolCalls.delete(toolUseId);
        } else {
          // Orphan: attach as standalone synthetic tool call so it isn't lost.
          const orphan: TraceToolCall = {
            id: typeof toolUseId === 'string' ? toolUseId : undefined,
            name: '<orphan_tool_result>',
            input: {},
            result: { content: truncated, isError },
          };
          const event: TraceEvent = {
            type: 'tool_use',
            timestamp,
            uuid,
            toolCalls: [orphan],
          };
          session.events.push(event);
          session.stats.totalEvents++;
          continue;
        }
      }

      // If the message has tool_results but no text, do not record a user event.
      if (toolResults.length > 0 && text === undefined) continue;

      const event: TraceEvent = {
        type: 'user',
        timestamp,
        uuid,
        text,
      };
      session.events.push(event);
      session.stats.totalEvents++;
      session.stats.userPrompts++;
      continue;
    }

    if (kind === 'assistant') {
      const msg = parsed.message;
      if (msg?.model && !session.model) session.model = msg.model;

      const content = Array.isArray(msg?.content) ? msg!.content : [];
      const { text, thinking, toolCalls } = extractAssistantBlocks(content);

      const event: TraceEvent = {
        type: 'assistant',
        timestamp,
        uuid,
        text,
        thinking,
        toolCalls,
      };

      if (toolCalls) {
        for (const call of toolCalls) {
          session.stats.toolCalls++;
          session.stats.toolCallsByName[call.name] =
            (session.stats.toolCallsByName[call.name] ?? 0) + 1;
          if (call.id) pendingToolCalls.set(call.id, call);
        }
      }

      session.events.push(event);
      session.stats.totalEvents++;
      continue;
    }

    if (kind === 'system') {
      session.events.push({ type: 'system', timestamp, uuid });
      session.stats.totalEvents++;
      continue;
    }

    // Unknown kind — keep but flag in warnings.
    session.warnings++;
  }

  session.startedAt = firstTs;
  session.endedAt = lastTs;
  if (firstTs && lastTs) {
    const startMs = Date.parse(firstTs);
    const endMs = Date.parse(lastTs);
    if (!Number.isNaN(startMs) && !Number.isNaN(endMs)) {
      session.stats.durationMs = endMs - startMs;
    }
  }

  return session;
}
