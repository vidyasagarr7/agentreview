import type { ProcessFinding, TraceEvent, TraceSession, TraceToolCall } from './types.js';

/**
 * Check if two tool calls are "similar" (same tool + similar input).
 * Used for retry storm detection.
 */
function isSimilarToolCall(a: TraceToolCall, b: TraceToolCall): boolean {
  if (a.name !== b.name) return false;
  // For Bash, compare the command string
  if (a.name === 'Bash') {
    const cmdA = typeof a.input.command === 'string' ? a.input.command : '';
    const cmdB = typeof b.input.command === 'string' ? b.input.command : '';
    return cmdA === cmdB;
  }
  // For file ops, compare file_path
  const pathA = typeof a.input.file_path === 'string' ? a.input.file_path : '';
  const pathB = typeof b.input.file_path === 'string' ? b.input.file_path : '';
  if (pathA && pathB) return pathA === pathB;
  // Generic: deep equality with sorted keys
  const sortedStringify = (obj: Record<string, unknown>) =>
    JSON.stringify(Object.keys(obj).sort().reduce((acc, k) => ({ ...acc, [k]: obj[k] }), {}));
  return sortedStringify(a.input) === sortedStringify(b.input);
}

/**
 * Detect dead ends: error → different approach attempted.
 * A dead end is when a tool call errors, and the agent tries a different approach
 * (different tool or different input) rather than retrying the same thing.
 */
function detectDeadEnds(events: TraceEvent[]): ProcessFinding[] {
  const findings: ProcessFinding[] = [];
  let deadEndCount = 0;
  const evidenceParts: string[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev.toolCalls) continue;

    for (const call of ev.toolCalls) {
      if (!call.result?.isError) continue;

      // Look at the next event with tool calls
      let nextToolEvent: TraceEvent | null = null;
      for (let j = i + 1; j < events.length; j++) {
        if (events[j].toolCalls && events[j].toolCalls!.length > 0) {
          nextToolEvent = events[j];
          break;
        }
      }

      if (!nextToolEvent?.toolCalls) continue;

      // Check if the next attempt is different (dead end) vs same (retry)
      const nextCall = nextToolEvent.toolCalls[0];
      if (!isSimilarToolCall(call, nextCall)) {
        deadEndCount++;
        const errSummary = call.result.content.slice(0, 80);
        evidenceParts.push(`${call.name}: ${errSummary}`);
      }
    }
  }

  if (deadEndCount > 0) {
    findings.push({
      signal: 'dead_end',
      severity: 'warning',
      description: `Agent had ${deadEndCount} dead end${deadEndCount > 1 ? 's' : ''} before reaching final solution. High count suggests fragility.`,
      evidence: evidenceParts.slice(0, 3).join(' → '),
      eventIndex: 0,
    });
  }

  return findings;
}

/**
 * Detect retry storms: same command retried 3+ times consecutively.
 */
function detectRetryStorms(events: TraceEvent[]): ProcessFinding[] {
  const findings: ProcessFinding[] = [];
  const allCalls: Array<{ call: TraceToolCall; eventIndex: number }> = [];

  for (let i = 0; i < events.length; i++) {
    if (events[i].toolCalls) {
      for (const call of events[i].toolCalls!) {
        allCalls.push({ call, eventIndex: i });
      }
    }
  }

  let i = 0;
  while (i < allCalls.length) {
    let j = i + 1;
    while (j < allCalls.length && isSimilarToolCall(allCalls[i].call, allCalls[j].call)) {
      j++;
    }
    const runLength = j - i;
    if (runLength >= 3) {
      const call = allCalls[i].call;
      const cmdSummary = call.name === 'Bash'
        ? (typeof call.input.command === 'string' ? call.input.command.slice(0, 60) : call.name)
        : call.name;
      findings.push({
        signal: 'retry_storm',
        severity: 'warning',
        description: `Same command retried ${runLength} times — suggests flaky approach.`,
        evidence: `${call.name}: ${cmdSummary} (repeated ${runLength}x)`,
        eventIndex: allCalls[i].eventIndex,
      });
    }
    i = j;
  }

  return findings;
}

/**
 * Detect unhandled errors: error in tool result → next action doesn't address it.
 * An "addressed" error means the next tool call targets the same file or runs a fix command.
 */
function detectUnhandledErrors(events: TraceEvent[]): ProcessFinding[] {
  const findings: ProcessFinding[] = [];

  for (let i = 0; i < events.length; i++) {
    const ev = events[i];
    if (!ev.toolCalls) continue;

    for (const call of ev.toolCalls) {
      if (!call.result?.isError) continue;

      // Look at the next 3 events for a fix attempt
      let addressed = false;
      for (let j = i + 1; j < Math.min(i + 4, events.length); j++) {
        const next = events[j];
        // If there's assistant text mentioning fix/error/issue, consider it addressed
        if (next.text && /\b(fix|error|issue|problem|correct|handle|catch)\b/i.test(next.text)) {
          addressed = true;
          break;
        }
        // If there's a tool call that could be a fix, consider it addressed
        if (next.toolCalls) {
          for (const nextCall of next.toolCalls) {
            // Same file being edited = likely fix
            if ((nextCall.name === 'Write' || nextCall.name === 'Edit') &&
                typeof call.input.file_path === 'string' &&
                typeof nextCall.input.file_path === 'string' &&
                call.input.file_path === nextCall.input.file_path) {
              addressed = true;
              break;
            }
            // Retry = addressing it
            if (isSimilarToolCall(call, nextCall)) {
              addressed = true;
              break;
            }
          }
        }
        if (addressed) break;
      }

      if (!addressed) {
        findings.push({
          signal: 'unhandled_error',
          severity: 'warning',
          description: 'Agent encountered an error but continued without addressing it.',
          evidence: `${call.name}: ${call.result.content.slice(0, 100)}`,
          eventIndex: i,
        });
      }
    }
  }

  return findings;
}

/**
 * Detect low exploration: agent went with first approach without trying alternatives.
 * Heuristic: if there's only one user prompt and no dead ends, exploration was low.
 */
function detectLowExploration(events: TraceEvent[]): ProcessFinding[] {
  const userPrompts = events.filter(e => e.type === 'user').length;
  const toolCalls = events.reduce((sum, e) => sum + (e.toolCalls?.length ?? 0), 0);

  // If there's a decent number of tool calls but only 1 user prompt and no errors,
  // the agent likely took the first approach without exploring.
  if (userPrompts <= 1 && toolCalls > 5) {
    const hasErrors = events.some(e =>
      e.toolCalls?.some(c => c.result?.isError) ?? false
    );
    if (!hasErrors) {
      return [{
        signal: 'low_exploration',
        severity: 'info',
        description: 'Agent went with first approach without exploring alternatives.',
        evidence: `Single prompt, ${toolCalls} tool calls, no errors — straightforward but potentially shallow.`,
        eventIndex: 0,
      }];
    }
  }

  return [];
}

/**
 * Analyze a trace session for process quality signals.
 * Returns findings sorted by severity (warnings first, then info).
 */
export function analyzeTrace(session: TraceSession): ProcessFinding[] {
  if (session.events.length === 0) return [];

  const findings: ProcessFinding[] = [
    ...detectDeadEnds(session.events),
    ...detectRetryStorms(session.events),
    ...detectUnhandledErrors(session.events),
    ...detectLowExploration(session.events),
  ];

  // Sort: warnings before info
  findings.sort((a, b) => {
    if (a.severity === b.severity) return 0;
    return a.severity === 'warning' ? -1 : 1;
  });

  return findings;
}
