import type { TraceEvent, TraceSession, TraceToolCall } from './types.js';

const TARGET_TOKENS = 60_000;
const HARD_CAP_TOKENS = 200_000;
const TOKENS_PER_CHAR = 0.4;
const BASH_CMD_MAX = 120;
const EXPLORATION_RUN_MIN = 6;

function estimateTokens(text: string): number {
  return text.length * TOKENS_PER_CHAR;
}

function renderToolCall(call: TraceToolCall): string {
  const name = call.name;
  const nameLower = name.toLowerCase();
  const input = call.input || {};

  if (nameLower === 'bash') {
    let cmd = (typeof input.command === 'string' ? input.command : '').trim();
    if (cmd.length > BASH_CMD_MAX) cmd = cmd.slice(0, BASH_CMD_MAX) + '…';
    const status = call.result ? (call.result.isError ? ' → ERR' : ' → OK') : '';
    return `Bash: ${cmd}${status}`;
  }

  if (nameLower === 'write' || nameLower === 'edit' || nameLower === 'replace') {
    const fp = typeof input.file_path === 'string' ? input.file_path : '';
    const content = typeof input.content === 'string' ? input.content : '';
    const sizeKb = (content.length / 1024).toFixed(1);
    return `${name} ${fp} (${sizeKb}KB)`;
  }

  if (nameLower === 'read') {
    const fp = typeof input.file_path === 'string' ? input.file_path : '';
    return `Read ${fp}`;
  }

  if (nameLower === 'grep' || nameLower === 'glob') {
    const pattern = typeof input.pattern === 'string' ? input.pattern :
      typeof input.query === 'string' ? input.query : '';
    const path = typeof input.path === 'string' ? input.path : '';
    return `${name} "${pattern}"${path ? ` in ${path}` : ''}`;
  }

  if (nameLower === 'task') {
    const desc = typeof input.description === 'string' ? input.description.slice(0, 100) : '';
    return `Subagent: ${desc}`;
  }

  if (nameLower === 'todowrite') return '';  // scratch, skip

  // Generic tool
  const fp = typeof input.file_path === 'string' ? input.file_path : '';
  return fp ? `${name} ${fp}` : name;
}

function renderEvent(event: TraceEvent): string | null {
  if (event.type === 'user') {
    return event.text ? `USER: ${event.text}` : null;
  }

  if (event.type === 'assistant') {
    const parts: string[] = [];
    if (event.text) parts.push(`ASSISTANT: ${event.text}`);
    if (event.toolCalls) {
      for (const call of event.toolCalls) {
        const rendered = renderToolCall(call);
        if (rendered) parts.push(rendered);
      }
    }
    return parts.length > 0 ? parts.join(' | ') : null;
  }

  return null;
}

function isToolOnlyLine(line: string): boolean {
  return !line.startsWith('USER:') && !line.startsWith('ASSISTANT:');
}

function hasError(line: string): boolean {
  return line.includes('→ ERR');
}

function collapseExploration(lines: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    if (isToolOnlyLine(lines[i]) && !hasError(lines[i])) {
      let j = i;
      while (j < lines.length && isToolOnlyLine(lines[j]) && !hasError(lines[j])) {
        j++;
      }
      const run = lines.slice(i, j);
      if (run.length >= EXPLORATION_RUN_MIN) {
        const counts: Record<string, number> = {};
        for (const line of run) {
          const tool = line.split(' ')[0].replace(':', '');
          counts[tool] = (counts[tool] || 0) + 1;
        }
        const summary = Object.entries(counts)
          .sort((a, b) => b[1] - a[1])
          .map(([t, n]) => `${n} ${t.toLowerCase()}${n !== 1 ? 's' : ''}`)
          .join(', ');
        out.push(`[exploration: ${summary}]`);
      } else {
        out.push(...run);
      }
      i = j;
    } else {
      out.push(lines[i]);
      i++;
    }
  }
  return out;
}

function truncateMiddle(lines: string[], hardCapTokens: number): string[] {
  if (lines.length <= 2) return lines;
  const targetChars = hardCapTokens / TOKENS_PER_CHAR;
  const headBudget = Math.max(targetChars * 0.5, lines[0].length + 1);
  const tailBudget = Math.max(targetChars * 0.5, lines[lines.length - 1].length + 1);

  const head: string[] = [lines[0]];
  let headChars = lines[0].length + 1;
  for (let i = 1; i < lines.length - 1; i++) {
    headChars += lines[i].length + 1;
    if (headChars > headBudget) break;
    head.push(lines[i]);
  }

  const tail: string[] = [lines[lines.length - 1]];
  let tailChars = lines[lines.length - 1].length + 1;
  for (let i = lines.length - 2; i >= head.length; i--) {
    tailChars += lines[i].length + 1;
    if (tailChars > tailBudget) break;
    tail.unshift(lines[i]);
  }

  const elided = lines.length - head.length - tail.length;
  if (elided <= 0) return [...head, ...tail];
  return [...head, `[… elided ${elided} events …]`, ...tail];
}

export function distillTrace(session: TraceSession): string {
  const lines: string[] = [];
  let prev: string | null = null;

  for (const event of session.events) {
    const rendered = renderEvent(event);
    if (!rendered) continue;
    if (rendered === prev) continue; // skip adjacent duplicates
    prev = rendered;
    lines.push(rendered);
  }

  let result = lines;

  if (estimateTokens(result.join('\n')) > TARGET_TOKENS) {
    result = collapseExploration(result);
  }

  if (estimateTokens(result.join('\n')) > HARD_CAP_TOKENS) {
    result = truncateMiddle(result, HARD_CAP_TOKENS);
  }

  return result.join('\n');
}
