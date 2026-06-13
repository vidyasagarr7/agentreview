import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocalSourceReader } from './local-reader.js';

describe('LocalSourceReader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-reader-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a regular file within root', async () => {
    fs.writeFileSync(path.join(tmpDir, 'hello.ts'), 'const x = 1;');
    const reader = new LocalSourceReader(tmpDir);
    const content = await reader.readFile('hello.ts');
    expect(content).toBe('const x = 1;');
  });

  it('lists files recursively, excluding skip patterns', async () => {
    // Create regular files
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), 'export {};');
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), 'main');

    // Create skip dirs
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), 'pkg');
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), 'ref');
    fs.mkdirSync(path.join(tmpDir, 'dist'));
    fs.writeFileSync(path.join(tmpDir, 'dist', 'bundle.js'), 'bundle');

    // Create files with skip extensions
    fs.writeFileSync(path.join(tmpDir, 'app.min.js'), 'minified');
    fs.writeFileSync(path.join(tmpDir, 'style.map'), 'map');
    fs.writeFileSync(path.join(tmpDir, 'icon.png'), 'png');
    fs.writeFileSync(path.join(tmpDir, 'package-lock.json'), '{}');

    const reader = new LocalSourceReader(tmpDir);
    const files = await reader.listFiles();
    const paths = files.map((f) => f.path).sort();

    expect(paths).toEqual(['index.ts', path.join('src', 'main.ts')]);
    // Verify priority is 0
    for (const f of files) {
      expect(f.priority).toBe(0);
    }
  });

  it('rejects symlink pointing outside root', async () => {
    // Create a symlink inside tmpDir that points to /tmp
    const linkPath = path.join(tmpDir, 'escape-link');
    fs.symlinkSync('/tmp', linkPath);

    const reader = new LocalSourceReader(tmpDir);
    const content = await reader.readFile('escape-link');
    expect(content).toBeNull();
  });

  it('rejects path traversal (../../../etc/passwd)', async () => {
    const reader = new LocalSourceReader(tmpDir);
    const content = await reader.readFile('../../../etc/passwd');
    expect(content).toBeNull();
  });

  it('skips files larger than 100KB', async () => {
    const largePath = path.join(tmpDir, 'large.ts');
    // Write 101KB of data
    fs.writeFileSync(largePath, 'x'.repeat(101 * 1024));

    const reader = new LocalSourceReader(tmpDir);
    const content = await reader.readFile('large.ts');
    expect(content).toBeNull();
  });

  it('skips non-regular files (directories)', async () => {
    fs.mkdirSync(path.join(tmpDir, 'subdir'));

    const reader = new LocalSourceReader(tmpDir);
    const content = await reader.readFile('subdir');
    expect(content).toBeNull();
  });

  it('filters out node_modules, .git, dist, and binary extensions from listing', async () => {
    // This test verifies the combined filtering behavior
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'app');
    fs.writeFileSync(path.join(tmpDir, 'logo.svg'), '<svg/>');
    fs.writeFileSync(path.join(tmpDir, 'font.woff2'), 'font');
    fs.writeFileSync(path.join(tmpDir, 'archive.zip'), 'zip');
    fs.writeFileSync(path.join(tmpDir, 'yarn.lock'), 'lock');

    fs.mkdirSync(path.join(tmpDir, 'build'));
    fs.writeFileSync(path.join(tmpDir, 'build', 'out.js'), 'out');
    fs.mkdirSync(path.join(tmpDir, '__pycache__'));
    fs.writeFileSync(path.join(tmpDir, '__pycache__', 'mod.pyc'), 'pyc');
    fs.mkdirSync(path.join(tmpDir, 'vendor'));
    fs.writeFileSync(path.join(tmpDir, 'vendor', 'lib.rb'), 'lib');
    fs.mkdirSync(path.join(tmpDir, '.next'));
    fs.writeFileSync(path.join(tmpDir, '.next', 'cache.js'), 'cache');
    fs.mkdirSync(path.join(tmpDir, 'coverage'));
    fs.writeFileSync(path.join(tmpDir, 'coverage', 'lcov.info'), 'lcov');

    const reader = new LocalSourceReader(tmpDir);
    const files = await reader.listFiles();
    const paths = files.map((f) => f.path);

    expect(paths).toEqual(['app.ts']);
  });

  it('returns file entries with correct size', async () => {
    const content = 'hello world';
    fs.writeFileSync(path.join(tmpDir, 'sized.ts'), content);

    const reader = new LocalSourceReader(tmpDir);
    const files = await reader.listFiles();
    expect(files).toHaveLength(1);
    expect(files[0].size).toBe(Buffer.byteLength(content));
  });

  it('returns null for non-existent files', async () => {
    const reader = new LocalSourceReader(tmpDir);
    const content = await reader.readFile('does-not-exist.ts');
    expect(content).toBeNull();
  });

  it('walk() skips directories when readdirSync throws (permission denied)', async () => {
    fs.writeFileSync(path.join(tmpDir, 'visible.ts'), 'ok');
    const denied = path.join(tmpDir, 'denied');
    fs.mkdirSync(denied);
    fs.writeFileSync(path.join(denied, 'hidden.ts'), 'secret');

    const originalReaddir = fs.readdirSync;
    const spy = vi.spyOn(fs, 'readdirSync').mockImplementation((...args: any[]) => {
      const p = typeof args[0] === 'string' ? args[0] : String(args[0]);
      if (p.endsWith('denied')) {
        throw new Error('EACCES: permission denied');
      }
      return originalReaddir.apply(fs, args as any);
    });

    const reader = new LocalSourceReader(tmpDir);
    const files = await reader.listFiles();
    const paths = files.map((f) => f.path).sort();

    expect(paths).toEqual(['visible.ts']);
    spy.mockRestore();
  });

  it('walk() skips entries when lstatSync throws', async () => {
    fs.writeFileSync(path.join(tmpDir, 'good.ts'), 'ok');
    fs.writeFileSync(path.join(tmpDir, 'bad.ts'), 'fail');

    const originalLstat = fs.lstatSync;
    const spy = vi.spyOn(fs, 'lstatSync').mockImplementation((...args: any[]) => {
      const p = typeof args[0] === 'string' ? args[0] : String(args[0]);
      if (p.endsWith('bad.ts')) {
        throw new Error('mock lstat error');
      }
      return originalLstat.apply(fs, args as any);
    });

    const reader = new LocalSourceReader(tmpDir);
    const files = await reader.listFiles();
    const paths = files.map((f) => f.path);

    expect(paths).toEqual(['good.ts']);
    spy.mockRestore();
  });

  it('readFile() returns null when realpathSync throws (broken symlink)', async () => {
    // Create a symlink pointing to a non-existent target
    const brokenLink = path.join(tmpDir, 'broken-link.ts');
    fs.symlinkSync('/tmp/nonexistent-target-xyz-12345', brokenLink);

    const reader = new LocalSourceReader(tmpDir);
    const content = await reader.readFile('broken-link.ts');
    expect(content).toBeNull();
  });

  it('readFile() returns null when statSync throws after realpath succeeds', async () => {
    fs.writeFileSync(path.join(tmpDir, 'stat-fail.ts'), 'content');

    const reader = new LocalSourceReader(tmpDir);

    const originalStat = fs.statSync;
    const spy = vi.spyOn(fs, 'statSync').mockImplementation((...args: any[]) => {
      const p = typeof args[0] === 'string' ? args[0] : String(args[0]);
      if (p.endsWith('stat-fail.ts')) {
        throw new Error('mock stat error');
      }
      return originalStat.apply(fs, args as any);
    });

    const content = await reader.readFile('stat-fail.ts');
    expect(content).toBeNull();
    spy.mockRestore();
  });
});
