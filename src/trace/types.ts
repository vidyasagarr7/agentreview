export type TraceEventType =
  | 'user'
  | 'assistant'
  | 'tool_use'
  | 'system'
  | 'unknown';

export interface TraceToolResult {
  content: string;
  isError: boolean;
}

export interface TraceToolCall {
  id?: string;
  name: string;
  input: Record<string, unknown>;
  result?: TraceToolResult;
}

export interface TraceEvent {
  type: TraceEventType;
  timestamp: string;
  uuid: string;
  text?: string;
  toolCalls?: TraceToolCall[];
  thinking?: string;
}

export interface TraceStats {
  totalEvents: number;
  userPrompts: number;
  toolCalls: number;
  toolCallsByName: Record<string, number>;
  errorCount: number;
  durationMs: number | null;
}

export interface TraceSession {
  sessionId: string | null;
  model: string | null;
  startedAt: string | null;
  endedAt: string | null;
  events: TraceEvent[];
  stats: TraceStats;
  warnings: number;
}

export interface ProcessFinding {
  signal: string;
  severity: 'info' | 'warning';
  description: string;
  evidence: string;
  eventIndex: number;
}
