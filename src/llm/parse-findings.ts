import type { AgentFinding, FindingSeverity, ParseError } from '../types/index.js';

const VALID_SEVERITIES = new Set<FindingSeverity>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW', 'INFO']);
const REQUIRED_FIELDS = ['id', 'severity', 'category', 'location', 'summary', 'detail', 'suggestion'];

function isValidSeverity(s: unknown): s is FindingSeverity {
  return typeof s === 'string' && VALID_SEVERITIES.has(s as FindingSeverity);
}

function validateFinding(raw: unknown, index: number): AgentFinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const obj = raw as Record<string, unknown>;

  for (const field of REQUIRED_FIELDS) {
    if (!obj[field] || typeof obj[field] !== 'string') {
      return null; // malformed finding — skip silently
    }
  }

  if (!isValidSeverity(obj.severity)) {
    return null;
  }

  return {
    id: obj.id as string || `finding-${index}`,
    severity: obj.severity as FindingSeverity,
    category: obj.category as string,
    location: obj.location as string,
    summary: obj.summary as string,
    detail: obj.detail as string,
    suggestion: obj.suggestion as string,
    lenses: [], // populated by dispatcher
  };
}

function tryParseArray(text: string): unknown[] | null {
  try {
    const parsed = JSON.parse(text);
    if (Array.isArray(parsed)) return parsed;
    // If it's an object with a findings key, unwrap it
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.findings)) {
      return parsed.findings;
    }
    return null;
  } catch {
    return null;
  }
}

function tryFixAndParse(text: string): unknown[] | null {
  // Try to fix common LLM JSON issues:
  // 1. Trailing commas: "key": "value", } → "key": "value" }
  const fixed = text
    .replace(/,(\s*[}\]])/g, '$1') // remove trailing commas before } or ]
    .replace(/\/\/[^\n]*/g, '') // remove // comments
    .replace(/\/\*[\s\S]*?\*\//g, ''); // remove /* */ comments

  return tryParseArray(fixed);
}

function extractJsonFromCodeFence(text: string): string | null {
  // Match ```json ... ``` or ``` ... ```
  const codeFenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  return codeFenceMatch ? codeFenceMatch[1].trim() : null;
}

function extractFirstJsonArray(text: string): string | null {
  // Find the first [ and try to extract a complete JSON array
  const startIdx = text.indexOf('[');
  if (startIdx === -1) return null;

  // Find matching closing bracket
  let depth = 0;
  let inString = false;
  let escape = false;

  for (let i = startIdx; i < text.length; i++) {
    const char = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (char === '\\' && inString) {
      escape = true;
      continue;
    }

    if (char === '"') {
      inString = !inString;
      continue;
    }

    if (!inString) {
      if (char === '[') depth++;
      else if (char === ']') {
        depth--;
        if (depth === 0) {
          return text.slice(startIdx, i + 1);
        }
      }
    }
  }

  return null;
}

/**
 * Parse LLM response into structured findings.
 *
 * IMPORTANT: This function NEVER returns [] on complete parse failure.
 * Instead, it returns a ParseError that surfaces in the final report.
 * This prevents false "clean" reports when the LLM returned garbage.
 */
export function parseFindings(raw: string, lensId: string): AgentFinding[] | ParseError {
  const trimmed = raw.trim();

  // Strategy 1: Direct JSON parse
  let items = tryParseArray(trimmed);

  // Strategy 2: Extract from markdown code fence
  if (!items) {
    const fenced = extractJsonFromCodeFence(trimmed);
    if (fenced) {
      items = tryParseArray(fenced) ?? tryFixAndParse(fenced);
    }
  }

  // Strategy 3: Find first JSON array in the text (handles "Here are my findings: [...]")
  if (!items) {
    const extracted = extractFirstJsonArray(trimmed);
    if (extracted) {
      items = tryParseArray(extracted) ?? tryFixAndParse(extracted);
    }
  }

  // Strategy 4: Try to fix and parse the full text
  if (!items) {
    items = tryFixAndParse(trimmed);
  }

  // All strategies failed — return a ParseError, NOT an empty array
  if (!items) {
    return {
      type: 'ParseError',
      lensId,
      raw: trimmed.slice(0, 300),
      message: `[PARSE ERROR] ${lensId} lens returned garbled response — results may be incomplete`,
    };
  }

  // Validate individual findings
  const valid: AgentFinding[] = [];
  let filteredCount = 0;

  for (let i = 0; i < items.length; i++) {
    const finding = validateFinding(items[i], i);
    if (finding) {
      valid.push(finding);
    } else {
      filteredCount++;
    }
  }

  if (filteredCount > 0) {
    console.warn(`⚠️  [${lensId}] Filtered ${filteredCount} malformed finding(s) from response.`);
  }

  // If items were present but ALL were malformed, this is a parse/validation failure.
  // Returning an empty array here would create a false "clean" report.
  if (items.length > 0 && valid.length === 0) {
    return {
      type: 'ParseError',
      lensId,
      raw: trimmed.slice(0, 300),
      message: `[PARSE ERROR] ${lensId} lens returned ${items.length} finding(s) but none passed validation — results may be incomplete`,
    };
  }

  return valid;
}
