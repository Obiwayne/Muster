// Shared roadmap fixture for the muster-mcp tests.
import type { Roadmap, RoadmapProgress } from '../types.js';

export const ROADMAP: Roadmap = {
  title: 'wall-education v1.0',
  summary: 'A wall for classrooms.',
  launchDate: '2026-11-15',
  status: 'approved',
  revision: 2,
  stages: [
    { id: 'M1', title: 'Foundations', description: '', start: '2026-09-01', due: '2026-09-14', status: 'done', exitCriteria: [{ text: 'CI green', done: true }], goalIds: ['G1'] },
    {
      id: 'M2', title: 'Core wall', description: '', start: '2026-09-15', due: '2026-10-10', status: 'active',
      exitCriteria: [{ text: 'Teachers can post', done: true }, { text: 'Students can react', done: false }, { text: 'Load test passes', done: false }],
      goalIds: ['G2', 'G3'],
    },
    { id: 'M3', title: 'Launch', description: '', status: 'planned', exitCriteria: [], goalIds: ['G4'] },
  ],
  goals: [
    { id: 'G1', stageId: 'M1', title: 'Repo setup', description: '', status: 'done' },
    { id: 'G2', stageId: 'M2', title: 'Posting', description: '', status: 'active' },
    { id: 'G3', stageId: 'M2', title: 'Reactions', description: '', status: 'planned', due: '2026-10-08' },
    { id: 'G4', stageId: 'M3', title: 'Store listing', description: '', status: 'planned' },
  ],
  createdBy: 'captain',
  updatedAt: '2026-10-01T10:00:00Z',
};

export const PROGRESS: RoadmapProgress = {
  overall: { done: 5, total: 12, percent: 42 },
  health: 'at_risk',
  daysToLaunch: 44,
  currentStageId: 'M2',
  currentGoalId: 'G2',
  stages: {
    M1: { done: 3, total: 3, percent: 100, health: 'done', criteriaDone: 1, criteriaTotal: 1 },
    M2: { done: 2, total: 8, percent: 25, health: 'at_risk', criteriaDone: 1, criteriaTotal: 3 },
    M3: { done: 0, total: 1, percent: 0, health: 'not_started', criteriaDone: 0, criteriaTotal: 0 },
  },
  goals: {
    G1: { done: 3, total: 3, percent: 100, agents: [] },
    G2: { done: 2, total: 5, percent: 40, agents: ['crew-2', 'crew-3'] },
    G3: { done: 0, total: 3, percent: 0, agents: [] },
    G4: { done: 0, total: 1, percent: 0, agents: [] },
  },
};
