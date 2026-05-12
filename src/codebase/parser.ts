// ─── parser.ts — Regex-based TS/JS import & export parser ───────────────────

export interface RawImport {
  module: string;     // the import specifier (e.g. './auth', '@octokit/rest')
  symbols?: string[]; // named imports if available
  isTypeOnly: boolean;
}

export interface RawExport {
  name: string;
  kind: 'function' | 'class' | 'type' | 'const' | 'default' | 'other';
}

// ─── Language detection ───────────────────────────────────────────────────────

export function detectLanguage(filename: string): 'ts' | 'js' | 'py' | 'other' {
  const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
  if (ext === '.ts' || ext === '.tsx') return 'ts';
  if (ext === '.js' || ext === '.jsx' || ext === '.mjs' || ext === '.cjs') return 'js';
  if (ext === '.py') return 'py';
  return 'other';
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Extract the module specifier from a quoted string */
function extractQuotedModule(s: string): string | null {
  const m = s.match(/['"]([^'"]+)['"]/);
  return m ? m[1] : null;
}

/** Parse a comma-separated list of symbols, stripping `as X` aliases */
function parseSymbolList(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim().replace(/\s+as\s+\S+$/, '').trim())
    .filter(Boolean);
}

// ─── Import parser ────────────────────────────────────────────────────────────

export function parseImports(source: string): RawImport[] {
  const results: RawImport[] = [];

  // Collapse multi-line import statements into single lines for easier regex matching.
  // Strategy: join lines that look like they're mid-import (have unclosed braces).
  const collapsed = source.replace(/import\s+[^;'"]*\{[^}]*\}/gs, (match) =>
    match.replace(/\s*\n\s*/g, ' '),
  );

  const lines = collapsed.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // ── export { X } from 'y' (re-exports) ──────────────────────────────────
    {
      const m = trimmed.match(/^export\s+(?:type\s+)?\{\s*([^}]*)\}\s+from\s+(['"])([^'"]+)\2/);
      if (m) {
        const isTypeOnly = /^export\s+type\s+/.test(trimmed);
        results.push({
          module: m[3],
          symbols: parseSymbolList(m[1]),
          isTypeOnly,
        });
        continue;
      }
    }

    // ── import type { X } from 'y' ───────────────────────────────────────────
    {
      const m = trimmed.match(/^import\s+type\s+\{\s*([^}]*)\}\s+from\s+(['"])([^'"]+)\2/);
      if (m) {
        results.push({ module: m[3], symbols: parseSymbolList(m[1]), isTypeOnly: true });
        continue;
      }
    }

    // ── import type X from 'y' (default type import) ─────────────────────────
    {
      const m = trimmed.match(/^import\s+type\s+(\w+)\s+from\s+(['"])([^'"]+)\2/);
      if (m) {
        results.push({ module: m[3], symbols: [m[1]], isTypeOnly: true });
        continue;
      }
    }

    // ── import * as X from 'y' ───────────────────────────────────────────────
    {
      const m = trimmed.match(/^import\s+\*\s+as\s+\w+\s+from\s+(['"])([^'"]+)\1/);
      if (m) {
        results.push({ module: m[2], isTypeOnly: false });
        continue;
      }
    }

    // ── import X, { a, b } from 'y' (default + named) ───────────────────────
    {
      const m = trimmed.match(/^import\s+\w+\s*,\s*\{\s*([^}]*)\}\s+from\s+(['"])([^'"]+)\2/);
      if (m) {
        results.push({ module: m[3], symbols: parseSymbolList(m[1]), isTypeOnly: false });
        continue;
      }
    }

    // ── import { a, b } from 'y' ─────────────────────────────────────────────
    {
      const m = trimmed.match(/^import\s+\{\s*([^}]*)\}\s+from\s+(['"])([^'"]+)\2/);
      if (m) {
        results.push({ module: m[3], symbols: parseSymbolList(m[1]), isTypeOnly: false });
        continue;
      }
    }

    // ── import X from 'y' (default import) ───────────────────────────────────
    {
      const m = trimmed.match(/^import\s+(\w+)\s+from\s+(['"])([^'"]+)\2/);
      if (m) {
        results.push({ module: m[3], symbols: [m[1]], isTypeOnly: false });
        continue;
      }
    }

    // ── import 'y' (side-effect) ─────────────────────────────────────────────
    {
      const m = trimmed.match(/^import\s+(['"])([^'"]+)\1\s*;?$/);
      if (m) {
        results.push({ module: m[2], isTypeOnly: false });
        continue;
      }
    }

    // ── require('y') ─────────────────────────────────────────────────────────
    {
      // Match require anywhere in the line (assignments, etc.)
      const requireRe = /require\s*\(\s*(['"])([^'"]+)\1\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = requireRe.exec(trimmed)) !== null) {
        results.push({ module: m[2], isTypeOnly: false });
      }
    }
  }

  return results;
}

// ─── Export parser ────────────────────────────────────────────────────────────

export function parseExports(source: string): RawExport[] {
  const results: RawExport[] = [];

  const lines = source.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('export')) continue;

    // ── export default ───────────────────────────────────────────────────────
    if (/^export\s+default\b/.test(trimmed)) {
      results.push({ name: 'default', kind: 'default' });
      continue;
    }

    // ── export type Name / export interface Name ──────────────────────────────
    {
      const m = trimmed.match(/^export\s+(?:type|interface)\s+(\w+)/);
      if (m) {
        results.push({ name: m[1], kind: 'type' });
        continue;
      }
    }

    // ── export async function name / export function name ────────────────────
    {
      const m = trimmed.match(/^export\s+(?:async\s+)?function\s+(\w+)/);
      if (m) {
        results.push({ name: m[1], kind: 'function' });
        continue;
      }
    }

    // ── export class Name ────────────────────────────────────────────────────
    {
      const m = trimmed.match(/^export\s+(?:abstract\s+)?class\s+(\w+)/);
      if (m) {
        results.push({ name: m[1], kind: 'class' });
        continue;
      }
    }

    // ── export const / export let / export var ───────────────────────────────
    {
      const m = trimmed.match(/^export\s+(?:const|let|var)\s+(\w+)/);
      if (m) {
        results.push({ name: m[1], kind: 'const' });
        continue;
      }
    }

    // ── export { name1, name2 } (without 'from' — local re-exports are handled separately) ──
    if (/^export\s+\{/.test(trimmed) && !/\bfrom\b/.test(trimmed)) {
      const m = trimmed.match(/^export\s+\{\s*([^}]+)\}/);
      if (m) {
        for (const sym of parseSymbolList(m[1])) {
          results.push({ name: sym, kind: 'other' });
        }
        continue;
      }
    }

    // ── export enum Name ─────────────────────────────────────────────────────
    {
      const m = trimmed.match(/^export\s+(?:const\s+)?enum\s+(\w+)/);
      if (m) {
        results.push({ name: m[1], kind: 'other' });
        continue;
      }
    }
  }

  return results;
}
