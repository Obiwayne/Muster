import { describe, expect, it } from 'vitest';
import type { Agent, MusterState, Note, Task } from '../../src/types';
import { emptyState } from '../../src/core/store';
import { BARREL_LANE, PUSHER_GAP, captainQuestion, shipView, weatherFor } from './shipmodel';

const CFG = { warnAtWeeklyPct: 75 };
const T0 = '2026-10-06T10:00:00.000Z';

function agent(id: string, role: Agent['role'], status: Agent['status'], taskId?: string): Agent {
  return { id, role, model: 'opus', branch: role === 'captain' ? 'main' : `${id}/work`, worktree: '', status, taskId, sessionId: id, startedAt: T0, lastActivityAt: T0, costUsd: 0 };
}

function task(id: string, stations: string[], stationIndex: number, status: Task['status'] = 'in_progress'): Task {
  return { id, title: `Task ${id}`, description: '', dependsOn: [], stations, stationIndex, status, createdBy: 'captain', createdAt: T0, updatedAt: T0, history: [] };
}

function note(id: string, over: Partial<Note>): Note {
  return { id, type: 'question', from: 'captain', text: 'Friendly page or plain 404?', createdAt: T0, open: true, replies: [], ...over };
}

function state(over: Partial<MusterState> = {}): MusterState {
  return { ...emptyState('/repo'), ...over };
}

describe('shipView', () => {
  it('puts the Captain at the helm, design in the crow\'s nest, testers at the cannon and builders on the main deck', () => {
    const s = state({
      agents: [agent('captain', 'captain', 'working'), agent('design', 'design', 'working'), agent('crew-2', 'crew', 'working', 'T1'),
        agent('crew-3', 'crew', 'working', 'T2'), agent('crew-5', 'crew', 'idle')],
      tasks: [task('T1', ['build', 'test', 'review'], 0), task('T2', ['build', 'test', 'review'], 1)],
    });
    const v = shipView(s, CFG);
    const at = (id: string) => v.sailors.find((x) => x.id === id)!;
    expect(at('captain')).toMatchObject({ x: 152, feet: 206, pose: 'captain' });
    expect(at('design')).toMatchObject({ x: 180, feet: 70 });
    expect(at('crew-2')).toMatchObject({ feet: 226, pose: 'hammer' });
    expect(at('crew-3')).toMatchObject({ x: 282, pose: 'stand' }); // at the cannon: the test station
    expect(at('crew-5')).toMatchObject({ pose: 'sit' });
    expect(v.tone).toBe('ok');
    expect(v.title).toBe('Fair winds');
    expect(v.sub).toBe('4 working · 1 idle · nothing needs you');
  });

  it('leaves stopped agents and the scout off the deck, and sends overflow below deck', () => {
    const crew = Array.from({ length: 7 }, (_, i) => agent(`crew-${i + 2}`, 'crew', 'working'));
    const s = state({ agents: [agent('captain', 'captain', 'working'), ...crew, agent('scout', 'research', 'working'), agent('old', 'crew', 'stopped')] });
    const v = shipView(s, CFG);
    expect(v.sailors.map((x) => x.id)).not.toContain('scout');
    expect(v.sailors.map((x) => x.id)).not.toContain('old');
    expect(v.sailors).toHaveLength(7); // helm + 3 main deck + stern + 2 at the cannon
    expect(v.below).toBe(1);
  });

  it('a Captain question makes the Captain wave and counts as needing you', () => {
    const s = state({ agents: [agent('captain', 'captain', 'working')], notes: [note('N142', { type: 'escalation' })] });
    const v = shipView(s, CFG);
    expect(v.question?.id).toBe('N142');
    expect(v.sailors[0].pose).toBe('captain_wave');
    expect(v.tone).toBe('needs');
    expect(v.title).toBe('1 needs you');
  });

  it('ignores closed, dismissed and system notes when looking for a question, and takes the newest', () => {
    const s = state({ notes: [
      note('N1', { open: false }),
      note('N2', { dismissed: true }),
      note('N3', { type: 'system', to: 'you', topic: 'weekly_usage' }),
      note('N4', { createdAt: '2026-10-06T09:00:00.000Z' }),
      note('N5', { createdAt: '2026-10-06T11:00:00.000Z' }),
      note('N6', { from: 'crew-2', to: 'captain' }),
    ] });
    expect(captainQuestion(s)?.id).toBe('N5');
  });

  it('fills the chest with reviewed tasks you have not approved yet', () => {
    const s = state({
      tasks: [task('T58', ['build', 'review'], 1, 'ready_for_merge'), task('T60', ['build', 'review'], 1, 'ready_for_merge'),
        { ...task('T61', ['build', 'review'], 1, 'ready_for_merge'), mergeApproval: { at: T0 } }],
      notes: [note('N1', { type: 'review', taskId: 'T58' }), note('N2', { type: 'review', taskId: 'T60' }), note('N3', { type: 'review', taskId: 'T61' })],
    });
    const v = shipView(s, CFG);
    expect(v.chest.map((t) => t.id)).toEqual(['T58', 'T60']);
    expect(v.sub).toBe('2 to approve');
  });

  it('a blocked merge, a stuck sailor or a storm is rough seas', () => {
    const s = state({
      agents: [agent('captain', 'captain', 'working'), agent('crew-3', 'crew', 'stuck')],
      notes: [note('N9', { type: 'system', from: 'muster', topic: 'checkout', text: '15 uncommitted files on WAYNE-PC' }),
        note('N10', { type: 'stuck', from: 'crew-3', text: 'Which token format does T2 use?' })],
      usage: { perAgentCostUsd: {}, paused: false, weeklyWarned: true, sevenDay: { usedPercentage: 92.4, resetsAt: T0 } },
    });
    const v = shipView(s, CFG);
    expect(v.fire?.id).toBe('N9');
    expect(v.stuck.map((e) => [e.sailor.id, e.sailor.pose, e.note?.id])).toEqual([['crew-3', 'stuck', 'N10']]);
    expect(v.weather).toBe('storm');
    expect(v.tone).toBe('trouble');
    expect(v.sub).toBe('merge blocked · crew-3 stuck · usage 92%');
  });

  it('drops anchor while new work is paused', () => {
    const v = shipView(state({ agents: [agent('captain', 'captain', 'idle')], usage: { perAgentCostUsd: {}, paused: true, weeklyWarned: false } }), CFG);
    expect(v.anchored).toBe(true);
    expect(v.title).toBe('Anchored');
  });

  it('shows the last two feed lines, newest first, without replies', () => {
    const s = state({ feed: [
      { id: 'F1', at: T0, kind: 'event', from: 'muster', text: 'T2 merged' },
      { id: 'F2', at: T0, kind: 'message', from: 'crew-2', text: 'picked up T3' },
      { id: 'F3', at: T0, kind: 'reply', from: 'captain', text: 'ok' },
    ] });
    expect(shipView(s, CFG).log.map((l) => l.text)).toEqual(['crew-2: picked up T3', 'T2 merged']);
  });
});

describe('weatherFor', () => {
  it('is clear below the warning, cloudy from it, stormy from 90%', () => {
    expect(weatherFor(null, 75)).toBe('clear');
    expect(weatherFor(74, 75)).toBe('clear');
    expect(weatherFor(75, 75)).toBe('clouds');
    expect(weatherFor(90, 75)).toBe('storm');
  });
});

describe('the barrel game', () => {
  const idleCrew = (n: number) => Array.from({ length: n }, (_, i) => agent(`crew-${i + 2}`, 'crew', 'idle'));

  it('three idle sailors roll the third along the main deck in a barrel; the rest still sit', () => {
    const s = state({ agents: [agent('captain', 'captain', 'working'), ...idleCrew(4)] });
    const v = shipView(s, CFG);
    const at = (id: string) => v.sailors.find((x) => x.id === id)!;
    expect(v.barrel).toEqual({ x: BARREL_LANE.x, feet: BARREL_LANE.feet });
    expect(at('crew-2')).toMatchObject({ pose: 'push', x: BARREL_LANE.x - PUSHER_GAP, word: 'idle · rolling' });
    expect(at('crew-3')).toMatchObject({ pose: 'push', x: BARREL_LANE.x + PUSHER_GAP, flip: true });
    expect(at('crew-4')).toMatchObject({ pose: 'barrel', x: BARREL_LANE.x, word: 'idle · in the barrel' });
    expect(at('crew-5')).toMatchObject({ pose: 'sit' });
    expect(v.sub).toBe('1 working · 4 idle · nothing needs you');
  });

  it('two idle sailors just sit', () => {
    const v = shipView(state({ agents: [agent('captain', 'captain', 'working'), ...idleCrew(2)] }), CFG);
    expect(v.barrel).toBeNull();
    expect(v.sailors.filter((x) => x.pose === 'sit')).toHaveLength(2);
  });

  it('waiting agents do not play: only idle or done ones', () => {
    const v = shipView(state({ agents: [...idleCrew(2), agent('crew-9', 'crew', 'waiting')] }), CFG);
    expect(v.barrel).toBeNull();
  });

  it('not while the chest is on the main deck', () => {
    const s = state({ agents: [agent('captain', 'captain', 'working'), ...idleCrew(3)], tasks: [task('T1', ['build', 'review'], 1, 'ready_for_merge')],
      notes: [note('N1', { type: 'review', taskId: 'T1' })] });
    expect(shipView(s, CFG).chest).toHaveLength(1);
    expect(shipView(s, CFG).barrel).toBeNull();
  });

  it('not when a working sailor would lose their spot to it', () => {
    const busy = Array.from({ length: 4 }, (_, i) => agent(`busy-${i}`, 'crew', 'working'));
    const v = shipView(state({ agents: [agent('captain', 'captain', 'working'), ...busy, ...idleCrew(3)] }), CFG);
    expect(v.barrel).toBeNull();
    expect(v.sailors.map((x) => x.id)).toEqual(expect.arrayContaining(busy.map((a) => a.id)));
    expect(v.sailors.some((x) => x.pose === 'push')).toBe(false);
  });

  it('plays alongside a couple of working sailors who fit at the cannon and the stern', () => {
    const busy = [agent('busy-1', 'crew', 'working'), agent('busy-2', 'crew', 'working')];
    const v = shipView(state({ agents: [agent('captain', 'captain', 'working'), ...busy, ...idleCrew(3)] }), CFG);
    expect(v.barrel).not.toBeNull();
    expect(v.below).toBe(0);
  });
});
