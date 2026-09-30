// Claude Code status line command: `node dist/usage/statusline.js` with the status-line JSON on stdin.
// Reports rate limits + cost to the orchestrator and prints one short line.
import { musterFetch } from '../client.js';

export interface StatusWindow {
  used_percentage?: number;
  resets_at?: number | string;
}

export interface StatusInput {
  session_id?: string;
  model?: { id?: string; display_name?: string };
  cost?: { total_cost_usd?: number };
  rate_limits?: { five_hour?: StatusWindow; seven_day?: StatusWindow };
}

function pct(w: StatusWindow | undefined): string | undefined {
  const v = w?.used_percentage;
  return typeof v === 'number' && Number.isFinite(v) ? `${Math.round(v)}%` : undefined;
}

export function formatStatusLine(input: StatusInput, agent?: string): string {
  const parts = ['muster'];
  if (agent) parts.push(agent);
  const five = pct(input.rate_limits?.five_hour);
  const week = pct(input.rate_limits?.seven_day);
  if (five) parts.push(`5h ${five}`);
  if (week) parts.push(`wk ${week}`);
  return parts.join(' · ');
}

function readStdin(timeoutMs = 1000): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let data = '';
    const done = () => {
      clearTimeout(timer);
      process.stdin.pause();
      resolve(data);
    };
    const timer = setTimeout(done, timeoutMs);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', done);
    process.stdin.on('error', done);
  });
}

async function main(): Promise<void> {
  let input: StatusInput = {};
  try {
    const raw = await readStdin();
    if (raw.trim()) input = JSON.parse(raw) as StatusInput;
  } catch {
    /* print what we can */
  }
  const agent = process.env.MUSTER_AGENT;
  const line = formatStatusLine(input ?? {}, agent);
  if (agent) {
    try {
      await musterFetch('/api/usage', {
        method: 'POST',
        body: { agentId: agent, rate_limits: input.rate_limits, cost: input.cost },
        timeoutMs: 1500,
      });
    } catch {
      /* ignore */
    }
  }
  await new Promise<void>((r) => process.stdout.write(line + '\n', () => r()));
}

// Only run when executed directly (not when imported by tests).
const entry = process.argv[1]?.replace(/\\/g, '/') ?? '';
if (/\/usage\/statusline\.(js|ts)$/.test(entry)) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0));
}
