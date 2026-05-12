import { execFile } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { randomBytes } from 'crypto';

function tmpPatchPath(repoDir: string): string {
  const id = randomBytes(4).toString('hex');
  return join(repoDir, `.agentreview-patch-${id}.patch`);
}

function runGitApply(args: string[], repoDir: string, patchFile: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['apply', ...args, patchFile], { cwd: repoDir }, (err) => {
      resolve(!err);
    });
  });
}

export async function applyPatch(patch: string, repoDir: string): Promise<boolean> {
  const patchFile = tmpPatchPath(repoDir);
  try {
    await writeFile(patchFile, patch, 'utf-8');
    return await runGitApply([], repoDir, patchFile);
  } catch {
    return false;
  } finally {
    try { await unlink(patchFile); } catch { /* ignore cleanup errors */ }
  }
}

export async function revertPatch(patch: string, repoDir: string): Promise<boolean> {
  const patchFile = tmpPatchPath(repoDir);
  try {
    await writeFile(patchFile, patch, 'utf-8');
    return await runGitApply(['--reverse'], repoDir, patchFile);
  } catch {
    return false;
  } finally {
    try { await unlink(patchFile); } catch { /* ignore cleanup errors */ }
  }
}
