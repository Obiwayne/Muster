// Design-crew check reports. The design prompt (src/prompts/index.ts) makes every check start with
// `PASS T# <summary>` or `DRIFT T# <summary>`, then one `path:line — what differs` line per difference.

export interface CheckDiff { path: string; line?: number; text: string }
export interface DesignCheck { verdict: 'pass' | 'drift'; taskId: string; summary: string; diffs: CheckDiff[] }

const HEAD = /^\s*(PASS|DRIFT)\s+(T\d+)\b[\s:–—-]*(.*)$/i;
const DIFF = /^\s*[-*•]?\s*`?([^\s:`]+?)(?::(\d+))?`?\s+[—–-]{1,2}\s+(.+?)\s*$/;

/** Parses one note's text; null when it isn't a check report (so the page ignores it). */
export function parseCheck(text: string): DesignCheck | null {
  const lines = text.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim() !== '');
  if (first < 0) return null;
  const m = HEAD.exec(lines[first]!);
  if (!m) return null;
  const diffs: CheckDiff[] = [];
  for (const l of lines.slice(first + 1)) {
    const d = DIFF.exec(l);
    if (!d || !/[\/.]/.test(d[1]!)) continue; // a path has a separator or an extension
    diffs.push({ path: d[1]!, ...(d[2] ? { line: Number(d[2]) } : {}), text: d[3]! });
  }
  return { verdict: m[1]!.toUpperCase() === 'PASS' ? 'pass' : 'drift', taskId: m[2]!.toUpperCase(), summary: m[3]!.trim(), diffs };
}
