// Fake project state for the phone gateway tests.
import type { MusterState, Note, Task } from '../types.js';
import { makeAgent } from '../core/testutil.js';

export const at = '2026-10-04T10:00:00.000Z';

export function fakeTask(id: string, extra: Partial<Task> = {}): Task {
  return { id, title: `Task ${id}`, description: '', dependsOn: [], stations: ['build', 'review'], stationIndex: 1, status: 'ready_for_merge', branch: `ada/${id}`, createdBy: 'captain', createdAt: at, updatedAt: at, history: [], ...extra };
}

export function fakeNote(id: string, extra: Partial<Note> = {}): Note {
  return { id, type: 'question', from: 'ada', to: 'you', text: `Note ${id}`, createdAt: at, open: true, replies: [], ...extra };
}

export function fakeState(notes: Note[], tasks: Task[] = []): MusterState {
  return {
    version: 1,
    repoRoot: '/tmp/x',
    agents: [makeAgent('captain', 'captain'), makeAgent('ada', 'crew', { taskId: 'T1' })],
    tasks,
    notes,
    feed: [],
    inbox: [],
    usage: { perAgentCostUsd: {}, paused: false, weeklyWarned: false, fiveHour: { usedPercentage: 42, resetsAt: at } },
    nextIds: { agent: 1, task: 1, note: 1, feed: 1, inbox: 1, stage: 1, goal: 1, idea: 1, run: 1, jot: 1 },
  };
}
