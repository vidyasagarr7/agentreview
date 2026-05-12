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
});
