import fs from 'node:fs';
import path from 'node:path';
import type { FileEntry, SourceReader } from './types.js';

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  '__pycache__',
  'vendor',
  '.next',
  'coverage',
]);

const SKIP_EXTENSIONS = new Set([
  '.min.js',
  '.map',
  '.svg',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.ico',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.pdf',
  '.zip',
  '.tar',
  '.gz',
  '.lock',
]);

const SKIP_FILENAMES = new Set([
  'package-lock.json',
  'pnpm-lock.yaml',
  'composer.lock',
  'gemfile.lock',
  'pipfile.lock',
  'poetry.lock',
  'cargo.lock',
]);

const MAX_FILE_SIZE = 100 * 1024; // 100 KB

function shouldSkipFile(filename: string): boolean {
  const lower = filename.toLowerCase();
  if (SKIP_FILENAMES.has(lower)) return true;
  for (const ext of SKIP_EXTENSIONS) {
    if (lower.endsWith(ext)) return true;
  }
  return false;
}

export class LocalSourceReader implements SourceReader {
  readonly rootReal: string;

  constructor(targetPath: string) {
    this.rootReal = fs.realpathSync(path.resolve(targetPath));
  }

  async listFiles(): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    this.walk(this.rootReal, entries);
    return entries;
  }

  private walk(dir: string, entries: FileEntry[]): void {
    let dirEntries: fs.Dirent[];
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // permission denied or similar — skip
    }

    for (const dirent of dirEntries) {
      const fullPath = path.join(dir, dirent.name);

      if (dirent.isDirectory()) {
        if (SKIP_DIRS.has(dirent.name)) continue;
        this.walk(fullPath, entries);
      } else if (dirent.isFile()) {
        if (shouldSkipFile(dirent.name)) continue;

        let stat: fs.Stats;
        try {
          stat = fs.lstatSync(fullPath);
        } catch {
          continue;
        }

        const relPath = path.relative(this.rootReal, fullPath);
        entries.push({
          path: relPath,
          size: stat.size,
          priority: 0,
        });
      }
      // Skip symlinks and other non-regular entries in listing
    }
  }

  async readFile(relPath: string): Promise<string | null> {
    const resolved = path.resolve(this.rootReal, relPath);

    // Realpath check — detect symlink escapes and path traversal
    let real: string;
    try {
      real = fs.realpathSync(resolved);
    } catch {
      return null; // broken symlink or doesn't exist
    }

    if (real !== this.rootReal && !real.startsWith(this.rootReal + path.sep)) {
      return null; // outside root
    }

    // Use resolved real path for all subsequent operations to prevent TOCTOU race.
    // If an attacker swaps a symlink between realpath check and read, we still
    // read from the validated path, not the potentially-swapped original.
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      return null;
    }

    if (!stat.isFile()) {
      return null;
    }

    // Size check
    if (stat.size > MAX_FILE_SIZE) {
      return null;
    }

    try {
      return fs.readFileSync(real, 'utf-8');
    } catch {
      return null;
    }
  }
}
