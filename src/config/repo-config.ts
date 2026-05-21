import { readFile } from 'fs/promises';
import { join } from 'path';
import { parse as parseYaml } from 'yaml';

export interface RepoScanConfig {
  focus?: string[];
  redact?: boolean;
  maxFiles?: number;
}

export interface HipaaConfig {
  baaCovered?: string[];    // Domains/patterns with signed BAA
  noBaa?: string[];         // Domains/patterns WITHOUT BAA (explicit deny)
  phiSources?: string[];    // File patterns that handle PHI (e.g., "src/services/patient*")
  phiFields?: string[];     // Additional field names to treat as PHI beyond defaults
}

export interface RepoConfig {
  lenses?: string[];
  failOn?: string;
  model?: string;
  validate?: boolean;
  minConfidence?: number;
  codebaseContext?: boolean;
  codebaseBudget?: number;
  ignore?: string[];
  scan?: RepoScanConfig;
  hipaa?: HipaaConfig;
}

const KNOWN_KEYS = new Set([
  'lenses',
  'fail-on',
  'model',
  'validate',
  'min-confidence',
  'codebase-context',
  'codebase-budget',
  'ignore',
  'scan',
  'hipaa',
]);

const KNOWN_HIPAA_KEYS = new Set(['baa-covered', 'no-baa', 'phi-sources', 'phi-fields']);

const KNOWN_SCAN_KEYS = new Set(['focus', 'redact', 'max-files']);

/**
 * Load and parse .agentreview.yml from the given repository root.
 * Returns null if the file does not exist.
 * Warns on unknown keys but does not throw.
 */
export async function loadRepoConfig(repoRoot: string): Promise<RepoConfig | null> {
  const configPath = join(repoRoot, '.agentreview.yml');

  let raw: string;
  try {
    raw = await readFile(configPath, 'utf-8');
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }

  const data = parseYaml(raw);

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    console.warn('⚠️  .agentreview.yml must be a YAML mapping — ignoring.');
    return null;
  }

  const obj = data as Record<string, unknown>;

  // Warn on unknown top-level keys
  for (const key of Object.keys(obj)) {
    if (!KNOWN_KEYS.has(key)) {
      console.warn(`⚠️  .agentreview.yml: unknown key "${key}" — ignoring.`);
    }
  }

  // Warn on unknown scan keys
  if (obj.scan && typeof obj.scan === 'object' && !Array.isArray(obj.scan)) {
    for (const key of Object.keys(obj.scan as Record<string, unknown>)) {
      if (!KNOWN_SCAN_KEYS.has(key)) {
        console.warn(`⚠️  .agentreview.yml scan: unknown key "${key}" — ignoring.`);
      }
    }
  }

  const config: RepoConfig = {};

  if (Array.isArray(obj.lenses)) {
    config.lenses = obj.lenses.filter((l): l is string => typeof l === 'string');
  }

  if (typeof obj['fail-on'] === 'string') {
    config.failOn = obj['fail-on'];
  }

  if (typeof obj.model === 'string') {
    config.model = obj.model;
  }

  if (typeof obj.validate === 'boolean') {
    config.validate = obj.validate;
  }

  if (typeof obj['min-confidence'] === 'number') {
    config.minConfidence = obj['min-confidence'];
  }

  if (typeof obj['codebase-context'] === 'boolean') {
    config.codebaseContext = obj['codebase-context'];
  }

  if (typeof obj['codebase-budget'] === 'number') {
    config.codebaseBudget = obj['codebase-budget'];
  }

  if (Array.isArray(obj.ignore)) {
    config.ignore = obj.ignore.filter((p): p is string => typeof p === 'string');
  }

  if (obj.scan && typeof obj.scan === 'object' && !Array.isArray(obj.scan)) {
    const scanObj = obj.scan as Record<string, unknown>;
    const scan: RepoScanConfig = {};
    if (Array.isArray(scanObj.focus)) {
      scan.focus = scanObj.focus.filter((f): f is string => typeof f === 'string');
    }
    if (typeof scanObj.redact === 'boolean') {
      scan.redact = scanObj.redact;
    }
    if (typeof scanObj['max-files'] === 'number') {
      scan.maxFiles = scanObj['max-files'];
    }
    config.scan = scan;
  }

  // Parse hipaa section
  if (obj.hipaa && typeof obj.hipaa === 'object' && !Array.isArray(obj.hipaa)) {
    const hipaaObj = obj.hipaa as Record<string, unknown>;

    // Warn on unknown hipaa keys
    for (const key of Object.keys(hipaaObj)) {
      if (!KNOWN_HIPAA_KEYS.has(key)) {
        console.warn(`⚠️  .agentreview.yml hipaa: unknown key "${key}" — ignoring.`);
      }
    }

    const hipaa: HipaaConfig = {};
    if (Array.isArray(hipaaObj['baa-covered'])) {
      hipaa.baaCovered = hipaaObj['baa-covered'].filter((v): v is string => typeof v === 'string');
    }
    if (Array.isArray(hipaaObj['no-baa'])) {
      hipaa.noBaa = hipaaObj['no-baa'].filter((v): v is string => typeof v === 'string');
    }
    if (Array.isArray(hipaaObj['phi-sources'])) {
      hipaa.phiSources = hipaaObj['phi-sources'].filter((v): v is string => typeof v === 'string');
    }
    if (Array.isArray(hipaaObj['phi-fields'])) {
      hipaa.phiFields = hipaaObj['phi-fields'].filter((v): v is string => typeof v === 'string');
    }
    config.hipaa = hipaa;
  }

  return config;
}
