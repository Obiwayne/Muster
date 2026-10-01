// GitHub through the `gh` CLI. The runner is injectable so tests never touch the network.
import { execFile } from 'node:child_process';

export interface GhResult {
  code: number; // exit code; -1 when gh could not be started
  stdout: string;
  stderr: string;
  missing?: boolean; // gh is not installed
}
export type GhRunner = (args: string[], cwd: string) => Promise<GhResult>;

export const realGh: GhRunner = (args, cwd) =>
  new Promise((resolve) => {
    execFile('gh', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120_000 }, (err, stdout, stderr) => {
      if (!err) return resolve({ code: 0, stdout, stderr });
      const e = err as NodeJS.ErrnoException & { code?: string | number };
      if (e.code === 'ENOENT') return resolve({ code: -1, stdout: '', stderr: 'gh not found', missing: true });
      resolve({ code: typeof e.code === 'number' ? e.code : 1, stdout: stdout ?? '', stderr: stderr || e.message });
    });
  });

export interface GhStatus {
  installed: boolean;
  authed: boolean;
  user?: string;
}

export async function ghStatus(run: GhRunner, cwd: string): Promise<GhStatus> {
  const v = await run(['--version'], cwd);
  if (v.missing || v.code !== 0) return { installed: false, authed: false };
  const a = await run(['auth', 'status'], cwd);
  if (a.code !== 0) return { installed: true, authed: false };
  const u = await run(['api', 'user', '--jq', '.login'], cwd);
  const user = u.code === 0 ? u.stdout.trim() : '';
  return { installed: true, authed: true, ...(user ? { user } : {}) };
}

/** `name` or `owner/name`; letters, digits, `.`, `_`, `-`. */
export const validRepoName = (name: string): boolean => /^(?:[A-Za-z0-9-]+\/)?[A-Za-z0-9._-]{1,100}$/.test(name) && !/^\.{1,2}$/.test(name.split('/').pop()!);
