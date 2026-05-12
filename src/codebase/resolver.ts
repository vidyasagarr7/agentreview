// ─── resolver.ts — Import path resolution against a RepoTree ────────────────

import type { RepoTree } from '../types/index.js';

// Build a Set of all blob paths for O(1) lookup
function buildPathSet(tree: RepoTree): Set<string> {
  const set = new Set<string>();
  for (const entry of tree.entries) {
    if (entry.type === 'blob') set.add(entry.path);
  }
  return set;
}

/** Normalize a path: collapse . and .. segments */
function normalizePath(p: string): string {
  const parts = p.split('/');
  const stack: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      stack.pop();
    } else if (part !== '.') {
      stack.push(part);
    }
  }
  return stack.join('/');
}

/** Returns true if moduleSpec is a relative import (starts with . or ..) */
export function isRelativeImport(spec: string): boolean {
  return spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..';
}

/**
 * Attempt to resolve a relative import specifier to a file that exists in the tree.
 * Tries, in order:
 *   1. Exact path
 *   2. path + .ts / .tsx / .js / .jsx
 *   3. path + /index.ts / /index.js
 */
function tryResolveRelative(
  basePath: string, // resolved base path (directory of importer)
  spec: string,
  pathSet: Set<string>,
): string | null {
  const joined = normalizePath(`${basePath}/${spec}`);

  const candidates = [
    joined,
    `${joined}.ts`,
    `${joined}.tsx`,
    `${joined}.js`,
    `${joined}.jsx`,
    `${joined}/index.ts`,
    `${joined}/index.js`,
  ];

  for (const candidate of candidates) {
    if (pathSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Resolve an import specifier to a tree path.
 *
 * @param importerPath - Path of the file that contains the import (e.g. "src/foo/bar.ts")
 * @param moduleSpec   - The raw import specifier (e.g. "./utils", "@octokit/rest")
 * @param tree         - The full repo tree
 * @returns The resolved path within the tree, or null for external/unresolvable imports
 */
export function resolveImport(
  importerPath: string,
  moduleSpec: string,
  tree: RepoTree,
): string | null {
  // Bare specifier → external (node_modules), cannot resolve
  if (!isRelativeImport(moduleSpec)) {
    return null;
  }

  const pathSet = buildPathSet(tree);

  // Determine the directory of the importer
  const lastSlash = importerPath.lastIndexOf('/');
  const importerDir = lastSlash >= 0 ? importerPath.slice(0, lastSlash) : '';

  // Strip a leading ./ from spec for cleaner join
  const cleanSpec = moduleSpec.startsWith('./')
    ? moduleSpec.slice(2)
    : moduleSpec;

  return tryResolveRelative(importerDir, cleanSpec, pathSet);
}
