import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import type { Lens } from '../types/index.js';
import { securityLens } from './builtin/security.js';
import { architectureLens } from './builtin/architecture.js';
import { qualityLens } from './builtin/quality.js';

const BUILTIN_LENSES: Lens[] = [securityLens, architectureLens, qualityLens];
const MAX_PROMPT_BYTES = 10 * 1024; // 10KB

function validateLens(data: unknown, source: string): Lens {
  const obj = data as Record<string, unknown>;

  const required = ['id', 'name', 'description', 'systemPrompt', 'focusAreas'];
  for (const field of required) {
    if (!obj[field]) {
      throw new Error(`Custom lens from ${source} is missing required field: "${field}"`);
    }
  }

  if (typeof obj.systemPrompt === 'string' && obj.systemPrompt.length > MAX_PROMPT_BYTES) {
    throw new Error(
      `Custom lens "${obj.id}" has a system prompt exceeding ${MAX_PROMPT_BYTES} bytes. ` +
      `This may cause excessive token usage.`
    );
  }

  if (!Array.isArray(obj.focusAreas)) {
    throw new Error(`Custom lens "${obj.id}" focusAreas must be an array.`);
  }

  return obj as unknown as Lens;
}

export class LensRegistry {
  private customLenses: Lens[] = [];

  getBuiltinLenses(): Lens[] {
    return [...BUILTIN_LENSES];
  }

  async loadCustomLenses(dir: string): Promise<Lens[]> {
    try {
      const entries = await readdir(dir);
      const jsonFiles = entries.filter((f) => f.endsWith('.json'));
      const loaded: Lens[] = [];

      for (const file of jsonFiles) {
        const filePath = join(dir, file);
        try {
          const raw = await readFile(filePath, 'utf-8');
          const data = JSON.parse(raw);
          const lens = validateLens(data, filePath);
          loaded.push(lens);
        } catch (err) {
          console.warn(`⚠️  Skipping custom lens ${file}: ${(err as Error).message}`);
        }
      }

      this.customLenses = loaded;
      return loaded;
    } catch (err) {
      // Directory doesn't exist — that's fine
      return [];
    }
  }

  getAllLenses(): Lens[] {
    return [...BUILTIN_LENSES, ...this.customLenses];
  }

  resolveLenses(ids: string[] | 'all'): Lens[] {
    const all = this.getAllLenses();

    if (ids === 'all') {
      return all;
    }

    const resolved: Lens[] = [];
    const unknownIds: string[] = [];

    for (const id of ids) {
      const lens = all.find((l) => l.id === id);
      if (lens) {
        resolved.push(lens);
      } else {
        unknownIds.push(id);
      }
    }

    if (unknownIds.length > 0) {
      const available = all.map((l) => l.id).join(', ');
      throw new Error(
        `Unknown lens ID(s): ${unknownIds.join(', ')}\n` +
        `Available lenses: ${available}`
      );
    }

    return resolved;
  }
}
