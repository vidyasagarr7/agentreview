import { describe, it, expect } from 'vitest';
import { parseImports, parseExports, detectLanguage } from './parser.js';

describe('detectLanguage', () => {
  it('detects TypeScript', () => {
    expect(detectLanguage('src/auth.ts')).toBe('ts');
    expect(detectLanguage('comp.tsx')).toBe('ts');
  });
  it('detects JavaScript', () => {
    expect(detectLanguage('index.js')).toBe('js');
    expect(detectLanguage('config.mjs')).toBe('js');
    expect(detectLanguage('util.cjs')).toBe('js');
  });
  it('detects Python', () => {
    expect(detectLanguage('main.py')).toBe('py');
  });
  it('returns other for unknown', () => {
    expect(detectLanguage('Makefile')).toBe('other');
    expect(detectLanguage('style.css')).toBe('other');
  });
});

describe('parseImports', () => {
  it('parses default import', () => {
    const result = parseImports("import React from 'react';");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('react');
  });

  it('parses named imports', () => {
    const result = parseImports("import { useState, useEffect } from 'react';");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('react');
    expect(result[0].symbols).toContain('useState');
    expect(result[0].symbols).toContain('useEffect');
  });

  it('parses namespace import', () => {
    const result = parseImports("import * as path from 'path';");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('path');
  });

  it('parses side-effect import', () => {
    const result = parseImports("import './setup';");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./setup');
  });

  it('parses type-only import', () => {
    const result = parseImports("import type { Foo } from './types';");
    expect(result).toHaveLength(1);
    expect(result[0].isTypeOnly).toBe(true);
  });

  it('parses re-export as import', () => {
    const result = parseImports("export { foo, bar } from './utils';");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./utils');
  });

  it('parses require()', () => {
    const result = parseImports("const fs = require('fs');");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('fs');
  });

  it('handles multiple imports', () => {
    const source = `
import React from 'react';
import { useState } from 'react';
import './styles.css';
    `;
    const result = parseImports(source);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  // ── Branch coverage: default + named combined import ──
  it('parses default + named combined import (import X, { a, b } from y)', () => {
    const result = parseImports("import React, { useState, useEffect } from 'react';");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('react');
    expect(result[0].symbols).toEqual(['useState', 'useEffect']);
    expect(result[0].isTypeOnly).toBe(false);
  });

  // ── Branch coverage: default type import (import type X from 'y') ──
  it('parses default type import (import type X from y)', () => {
    const result = parseImports("import type Foo from './types';");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./types');
    expect(result[0].symbols).toEqual(['Foo']);
    expect(result[0].isTypeOnly).toBe(true);
  });

  // ── Branch coverage: type re-export (export type { X } from 'y') ──
  it('parses type re-export (export type { X } from y)', () => {
    const result = parseImports("export type { Foo, Bar } from './types';");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./types');
    expect(result[0].symbols).toEqual(['Foo', 'Bar']);
    expect(result[0].isTypeOnly).toBe(true);
  });

  // ── Branch coverage: barrel re-export (export * from 'y') ──
  it('parses barrel re-export (export * from y)', () => {
    const result = parseImports("export * from './utils';");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./utils');
    expect(result[0].isTypeOnly).toBe(false);
  });

  // ── Branch coverage: barrel re-export with alias (export * as X from 'y') ──
  it('parses barrel re-export with alias (export * as X from y)', () => {
    const result = parseImports("export * as utils from './utils';");
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./utils');
    expect(result[0].isTypeOnly).toBe(false);
  });

  // ── Branch coverage: named import with alias stripping ──
  it('strips aliases from named imports', () => {
    const result = parseImports("import { foo as bar, baz as qux } from './mod';");
    expect(result).toHaveLength(1);
    expect(result[0].symbols).toEqual(['foo', 'baz']);
  });

  // ── Branch coverage: multi-line import collapsed ──
  it('handles multi-line imports', () => {
    const source = `import {
  foo,
  bar,
  baz
} from './mod';`;
    const result = parseImports(source);
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./mod');
    expect(result[0].symbols).toEqual(['foo', 'bar', 'baz']);
  });

  // ── Branch coverage: comment stripping — block comments ──
  it('ignores imports inside block comments', () => {
    const source = `/* import { foo } from 'bar'; */
import { real } from './real';`;
    const result = parseImports(source);
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./real');
  });

  // ── Branch coverage: comment stripping — single-line comments ──
  it('ignores imports inside single-line comments', () => {
    const source = `// import { foo } from 'bar';
import { real } from './real';`;
    const result = parseImports(source);
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./real');
  });

  // ── Branch coverage: string literals with comment-like content ──
  it('preserves string literals containing // and /* during comment stripping', () => {
    const source = `const url = "http://example.com";
import { foo } from './bar';`;
    const result = parseImports(source);
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./bar');
  });

  // ── Branch coverage: string with escape sequences during comment stripping ──
  it('handles escape sequences in strings during comment stripping', () => {
    const source = `const s = "hello\\nworld";
import { foo } from './bar';`;
    const result = parseImports(source);
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./bar');
  });

  // ── Branch coverage: backtick template literals during comment stripping ──
  it('handles template literals with comment-like content', () => {
    const source = "const s = `// not a comment /* also not */`;\nimport { foo } from './bar';";
    const result = parseImports(source);
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./bar');
  });

  // ── Branch coverage: multiple require() in one line ──
  it('parses multiple require() calls in a single line', () => {
    const result = parseImports("const a = require('fs'), b = require('path');");
    expect(result).toHaveLength(2);
    expect(result[0].module).toBe('fs');
    expect(result[1].module).toBe('path');
  });

  // ── Branch coverage: empty/blank lines skipped ──
  it('handles source with only blank lines', () => {
    const result = parseImports('\n\n\n');
    expect(result).toHaveLength(0);
  });

  // ── Branch coverage: non-matching lines are skipped ──
  it('skips non-import lines', () => {
    const source = `const x = 5;
function foo() {}
import { bar } from './bar';`;
    const result = parseImports(source);
    expect(result).toHaveLength(1);
    expect(result[0].module).toBe('./bar');
  });
});

describe('parseExports', () => {
  it('parses exported function', () => {
    const result = parseExports('export function doStuff() {}');
    expect(result.some((e) => e.name === 'doStuff' && e.kind === 'function')).toBe(true);
  });

  it('parses exported class', () => {
    const result = parseExports('export class MyClass {}');
    expect(result.some((e) => e.name === 'MyClass' && e.kind === 'class')).toBe(true);
  });

  it('parses exported const', () => {
    const result = parseExports('export const FOO = 42;');
    expect(result.some((e) => e.name === 'FOO' && e.kind === 'const')).toBe(true);
  });

  it('parses exported type', () => {
    const result = parseExports('export type Foo = string;');
    expect(result.some((e) => e.name === 'Foo' && e.kind === 'type')).toBe(true);
  });

  it('parses export default', () => {
    const result = parseExports('export default function main() {}');
    expect(result.some((e) => e.kind === 'default')).toBe(true);
  });

  // ── Branch coverage: export enum ──
  it('parses export enum', () => {
    const result = parseExports('export enum Status { Active, Inactive }');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Status');
    expect(result[0].kind).toBe('other');
  });

  // ── Branch coverage: export const enum ──
  it('parses export const enum', () => {
    const result = parseExports('export const enum Direction { Up, Down }');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Direction');
    expect(result[0].kind).toBe('other');
  });

  // ── Branch coverage: export let ──
  it('parses export let', () => {
    const result = parseExports('export let counter = 0;');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('counter');
    expect(result[0].kind).toBe('const');
  });

  // ── Branch coverage: export var ──
  it('parses export var', () => {
    const result = parseExports('export var legacy = true;');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('legacy');
    expect(result[0].kind).toBe('const');
  });

  // ── Branch coverage: export { a, b } (local named exports, no 'from') ──
  it('parses local named exports (export { a, b })', () => {
    const result = parseExports('export { foo, bar, baz };');
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ name: 'foo', kind: 'other' });
    expect(result[1]).toEqual({ name: 'bar', kind: 'other' });
    expect(result[2]).toEqual({ name: 'baz', kind: 'other' });
  });

  // ── Branch coverage: export { a as b } with alias stripping ──
  it('parses named exports with aliases', () => {
    const result = parseExports('export { foo as default, bar as renamed };');
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('foo');
    expect(result[1].name).toBe('bar');
  });

  // ── Branch coverage: export interface ──
  it('parses export interface', () => {
    const result = parseExports('export interface Config { key: string; }');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Config');
    expect(result[0].kind).toBe('type');
  });

  // ── Branch coverage: export async function ──
  it('parses export async function', () => {
    const result = parseExports('export async function fetchData() {}');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('fetchData');
    expect(result[0].kind).toBe('function');
  });

  // ── Branch coverage: export abstract class ──
  it('parses export abstract class', () => {
    const result = parseExports('export abstract class BaseService {}');
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('BaseService');
    expect(result[0].kind).toBe('class');
  });

  // ── Branch coverage: export default (non-function) ──
  it('parses export default class', () => {
    const result = parseExports('export default class App {}');
    expect(result).toHaveLength(1);
    expect(result[0].kind).toBe('default');
  });

  // ── Branch coverage: non-export lines are skipped ──
  it('skips non-export lines', () => {
    const source = `const x = 5;
function internal() {}
export function pub() {}`;
    const result = parseExports(source);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('pub');
  });

  // ── Branch coverage: export { } from 'x' is NOT a local export (has 'from') ──
  it('does not treat re-exports as local named exports', () => {
    const result = parseExports("export { foo } from './bar';");
    // Re-exports with 'from' are NOT captured by parseExports
    expect(result).toHaveLength(0);
  });

  // ── Branch coverage: comments in export source are stripped ──
  it('strips comments before parsing exports', () => {
    const source = `// export const FAKE = 1;
export const REAL = 2;`;
    const result = parseExports(source);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('REAL');
  });
});
