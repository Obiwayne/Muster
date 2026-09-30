import { describe, expect, it } from 'vitest';
import type { Agent, FeedItem, MusterState, Note, Task } from '../types.js';
import { DEFAULT_CONFIG } from '../types.js';
import {
  bar,
  colors,
  formatFeedItem,
  formatNotes,
  formatStatus,
  formatTasks,
  formatUsage,
  idNum,
  needsYou,
  relativeTime,
  stripAnsi,
  table,
  truncate,
  visibleLength,
} from './format.js';

const now = new Date('2026-09-30T12:00:00Z');
const ago = (s: number) => new Date(now.getTime() - s * 1000).toISOString();
const plain = colors(false);
const tty = colors(true);

function agent(p: Partial<Agent>): Agent {
  return { id: 'crew-2', role: 'crew', model: 'sonnet', branch: 'crew-2/work', worktree: '/r', status: 'idle', sessionId: 's', startedAt: ago(600), lastActivityAt: ago(120), costUsd: 0, ...p };
}
function note(p: Partial<Note>): Note {
  return { id: 'N1', type: 'progress', from: 'crew-2', text: 'hello', createdAt: ago(60), open: false, replies: [], ...p };
}
function state(p: Partial<MusterState>): MusterState {
  return { version: 1, repoRoot: '/r', agents: [], tasks: [], notes: [], feed: [], inbox: [], usage: { perAgentCostUsd: {}, paused: false, weeklyWarned: false }, nextIds: { agent: 1, task: 1, note: 1, feed: 1, inbox: 1 }, ...p };
}

describe('relativeTime', () => {
  it('formats past and future', () => {
    expect(relativeTime(ago(2), now)).toBe('just now');
    expect(relativeTime(ago(30), now)).toBe('30s ago');
    expect(relativeTime(ago(5 * 60), now)).toBe('5m ago');
    expect(relativeTime(ago(2 * 3600 + 600), now)).toBe('2h ago');
    expect(relativeTime(ago(3 * 86400), now)).toBe('3d ago');
    expect(relativeTime(new Date(now.getTime() + (2 * 3600 + 10 * 60) * 1000).toISOString(), now)).toBe('in 2h 10m');
  });
  it('accepts unix seconds and handles missing values', () => {
    expect(relativeTime(Math.floor(now.getTime() / 1000) - 120, now)).toBe('2m ago');
    expect(relativeTime(undefined, now)).toBe('-');
    expect(relativeTime('garbage', now)).toBe('-');
  });
});

describe('bar / truncate / table', () => {
  it('draws proportional bars and clamps', () => {
    expect(bar(50, 10)).toBe('█████░░░░░');
    expect(bar(0, 4)).toBe('░░░░');
    expect(bar(150, 4)).toBe('████');
    expect(bar(NaN, 4)).toBe('░░░░');
  });
  it('truncates with an ellipsis and collapses whitespace', () => {
    expect(truncate('a  b\nc', 10)).toBe('a b c');
    expect(truncate('abcdefghij', 5)).toBe('abcd…');
  });
  it('pads by visible width, ignoring ANSI', () => {
    const t = table(['A', 'B'], [[tty.red('xx'), '1'], ['y', '22']]);
    const lines = t.split('\n').map(stripAnsi);
    expect(lines).toEqual(['A   B', 'xx  1', 'y   22']);
    expect(visibleLength(tty.amber('abc'))).toBe(3);
  });
});

describe('colours', () => {
  it('are plain when disabled and ANSI when enabled', () => {
    expect(plain.amber('x')).toBe('x');
    expect(tty.amber('x')).toContain('\x1b[38;5;214m');
    expect(tty.red('x')).toContain('\x1b[31m');
  });
});

describe('formatStatus', () => {
  const s = state({
    goal: { text: 'Add sharing', at: ago(600) },
    agents: [
      agent({ id: 'crew-2', status: 'stuck', taskId: 'T1' }),
      agent({ id: 'captain', role: 'captain', branch: 'main', status: 'working', lastActivityAt: ago(3) }),
      agent({ id: 'design', role: 'design', branch: 'design/work' }),
    ],
    tasks: [{ id: 'T1', title: 'Share dialog', description: '', dependsOn: [], stations: ['build', 'review'], stationIndex: 0, status: 'in_progress', createdBy: 'captain', createdAt: ago(900), updatedAt: ago(100), history: [] }],
    notes: [note({ id: 'N1', type: 'stuck', open: true }), note({ id: 'N2', type: 'review', open: true, from: 'captain' }), note({ id: 'N3' })],
    usage: { fiveHour: { usedPercentage: 83, resetsAt: new Date(now.getTime() + 3600e3).toISOString() }, sevenDay: { usedPercentage: 40 }, perAgentCostUsd: {}, paused: true, weeklyWarned: false },
  });
  it('lists the captain first with task, activity, usage and board counts', () => {
    const out = formatStatus({ state: s, config: DEFAULT_CONFIG, paused: true }, plain, now);
    const lines = out.split('\n');
    expect(lines[0]).toContain('Goal: Add sharing');
    const rows = lines.filter((l) => /^(captain|crew-2|design)\s/.test(l));
    expect(rows.map((r) => r.split(/\s+/)[0])).toEqual(['captain', 'crew-2', 'design']);
    expect(out).toMatch(/crew-2\s+crew\s+stuck\s+crew-2\/work\s+T1 Share dialog\s+2m ago/);
    expect(out).toContain('just now');
    expect(out).toContain('5h 83% · wk 40%');
    expect(out).toContain('PAUSED: 5-hour window at 83%');
    expect(out).toContain('Board: 2 open notes · 1 needs you · 1 stuck');
  });
  it('colours roles and stuck when enabled', () => {
    const out = formatStatus({ state: s, config: DEFAULT_CONFIG, paused: true }, tty, now);
    expect(out).toContain('\x1b[38;5;214mcaptain');
    expect(out).toContain('\x1b[38;5;183mdesign');
    expect(out).toContain('\x1b[31mstuck');
  });
  it('handles no agents', () => {
    expect(formatStatus({ state: state({}), config: DEFAULT_CONFIG, paused: false }, plain, now)).toContain('No agents yet');
  });
});

describe('notes, tasks, usage, feed', () => {
  it('formats notes with replies and needs-you', () => {
    const n = note({ id: 'N14', type: 'escalation', open: true, from: 'captain', taskId: 'T3', replies: [{ at: ago(1), from: 'you', text: 'ok' }, { at: ago(1), from: 'x', text: 'y' }] });
    expect(needsYou(n)).toBe(true);
    expect(needsYou(note({ open: true, to: 'you', type: 'question' }))).toBe(true);
    expect(needsYou(note({ type: 'stuck', open: true }))).toBe(false);
    const out = formatNotes([n], plain, now);
    expect(out).toMatch(/N14\s+escalation\s+captain\s+T3\s+1m ago\s+hello\s+\[2 replies, needs you\]/);
    expect(formatNotes([], plain, now)).toBe('No notes.');
  });
  it('formats tasks with station progress', () => {
    const t: Task = { id: 'T2', title: 'Tests', description: '', dependsOn: ['T1'], stations: ['build', 'test', 'review'], stationIndex: 1, status: 'in_progress', assignee: 'crew-3', createdBy: 'captain', createdAt: ago(100), updatedAt: ago(100), history: [] };
    expect(formatTasks([t], plain, now)).toMatch(/T2\s+in_progress\s+test 2\/3\s+crew-3\s+T1\s+1m ago\s+Tests/);
  });
  it('formats usage bars, resets and cost share', () => {
    const out = formatUsage(
      { fiveHour: { usedPercentage: 50, resetsAt: new Date(now.getTime() + 90 * 60e3).toISOString() }, perAgentCostUsd: { captain: 3, 'crew-2': 1 }, paused: false, weeklyWarned: false },
      DEFAULT_CONFIG,
      plain,
      now,
    );
    expect(out).toContain('5-hour  ██████████░░░░░░░░░░   50%  resets');
    expect(out).toContain('(in 1h 30m)');
    expect(out).toContain('Weekly');
    expect(out).toContain('no data yet');
    expect(out).toMatch(/captain\s+\$3\.00\s+75%/);
    expect(out).toMatch(/crew-2\s+\$1\.00\s+25%/);
    expect(out).toContain('Total $4.00');
    expect(formatUsage({ perAgentCostUsd: {}, paused: true, weeklyWarned: false }, DEFAULT_CONFIG, plain, now)).toContain('Paused');
  });
  it('formats feed items by kind', () => {
    const f = (p: Partial<FeedItem>): FeedItem => ({ id: 'F1', at: now.toISOString(), kind: 'message', from: 'crew-2', text: 'hi', ...p });
    expect(formatFeedItem(f({ to: 'captain' }), plain, now)).toMatch(/crew-2 → captain  hi$/);
    expect(formatFeedItem(f({ kind: 'reply', noteId: 'N14' }), plain, now)).toContain('crew-2 ↳ N14  hi');
    expect(formatFeedItem(f({ kind: 'note', noteId: 'N2', noteType: 'stuck' }), plain, now)).toContain('crew-2 pinned stuck N2: hi');
    expect(formatFeedItem(f({ kind: 'event', from: 'muster', text: 'crew-2 started' }), plain, now)).toContain('· crew-2 started');
    expect(idNum('F120')).toBe(120);
  });
});
