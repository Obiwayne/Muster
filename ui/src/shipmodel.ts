// Ship view (Dashboard → Ship): turns the state into who stands where on the pirate ship and which signs are up.
// Pure, so it is tested without a DOM. Coordinates are art pixels in the 470×277 scene (see shipart.ts, pages/ship.ts). Design: Vellum "Muster" › Ship.
import type { Agent, FeedItem, MusterConfig, MusterState, Note, Role, Task } from '../../src/types';
import { YOU, awaitingApproval, hhmm, taskById } from './util';

export const SCENE_W = 470;
export const SCENE_H = 277;
/** Where the ship sprite's top-left sits in the scene; deck spots below are measured on the sprite from here. */
export const SHIP_X = 70;
export const SHIP_Y = 0;
/** Below this line the hull is under water (the keel is hidden by the sea). */
export const WATERLINE = SHIP_Y + 262;

export type Pose = 'stand' | 'hammer' | 'haul' | 'sit' | 'stuck' | 'captain' | 'captain_wave' | 'push' | 'barrel';
export type Weather = 'clear' | 'clouds' | 'storm';

export interface Sailor {
  id: string;
  role: Role;
  pose: Pose;
  x: number; // centre
  feet: number; // y the feet stand on
  flip?: boolean;
  tagLift?: number; // raise the name tag so neighbours on the main deck don't overlap
  status: Agent['status'];
  word: string; // short status for the name tag
}

export interface ShipView {
  sailors: Sailor[];
  below: number; // working agents with no spot left on deck
  question: Note | null; // the Captain asks you something
  chest: Task[]; // reviewed work waiting for your approval
  fire: Note | null; // merge blocked by uncommitted files
  stuck: { sailor: Sailor; note?: Note }[];
  barrel: { x: number; feet: number } | null; // three idle sailors roll one of them along the main deck in a barrel
  weather: Weather;
  weeklyPct: number | null;
  anchored: boolean; // new work paused for the 5-hour window
  tone: 'ok' | 'needs' | 'trouble';
  title: string;
  sub: string;
  log: { at: string; text: string }[];
}

interface Spot { x: number; feet: number; pose?: Pose; flip?: boolean; tagLift?: number }

const at = (x: number, y: number): { x: number; feet: number } => ({ x: SHIP_X + x, feet: SHIP_Y + y });
const HELM: Spot = at(82, 206);
const NEST: Spot = at(110, 70);
const MAIN_DECK: Spot[] = [
  { ...at(134, 226), pose: 'hammer' },
  { ...at(174, 226), pose: 'haul', flip: true, tagLift: 12 },
  { ...at(154, 226), pose: 'hammer', flip: true, tagLift: 24 },
];
const CANNON: Spot[] = [at(212, 203), at(196, 204)];
const STERN: Spot[] = [{ ...at(58, 206), pose: 'hammer' }];
const RIGGING: Spot[] = [at(159, 190), at(60, 150)]; // right rope first: the left one sits under the Captain's bubble
const REST: Spot[] = [at(262, 186), at(58, 206)];
/** The barrel game rolls back and forth along the main deck around here. */
export const BARREL_LANE = at(150, 226);
/** Where the two pushers stand (behind the barrel, hands on top) from its centre. */
export const PUSHER_GAP = 10;

/** Truly idle: no task, not waiting on anyone. Three or more of these play the barrel game. */
function idle(a: Agent): boolean {
  return a.status === 'idle' || a.status === 'done';
}

/** Agents doing nothing for you right now sit and rest. */
function resting(a: Agent): boolean {
  return a.status === 'idle' || a.status === 'waiting' || a.status === 'done' || a.status === 'starting';
}

function station(state: MusterState, a: Agent): string | undefined {
  const t = taskById(state, a.taskId);
  return t ? t.stations[t.stationIndex] : undefined;
}

/** One short word for a sailor's name tag: "building", "testing", "reviewing", "idle"… */
export function tagWord(state: MusterState, a: Agent): string {
  if (a.status === 'stuck') return 'stuck';
  if (a.status === 'waiting') return 'waiting';
  if (a.status === 'idle' || a.status === 'done') return 'idle · zzz';
  if (a.status !== 'working') return a.status;
  if (a.role === 'captain') return state.tasks.some((t) => t.status === 'review') ? 'reviewing' : 'at the helm';
  const st = station(state, a);
  const words: Record<string, string> = { build: 'building', test: 'testing', qa: 'checking', design: 'designing', review: 'in review' };
  return st ? (words[st] ?? st) : 'working';
}

/** The newest open question or decision the Captain put to you (not system notes like usage or the checkout). */
export function captainQuestion(state: MusterState): Note | null {
  const asks = state.notes.filter((n) => n.open && !n.dismissed && n.from === 'captain'
    && (n.type === 'escalation' || n.type === 'question' || (n.to === YOU && n.type !== 'review' && n.type !== 'system')));
  return asks.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export function blockedMerge(state: MusterState): Note | null {
  return state.notes.find((n) => n.open && !n.dismissed && n.topic === 'checkout') ?? null;
}

export function weatherFor(pct: number | null, warnAt: number): Weather {
  if (pct === null) return 'clear';
  if (pct >= 90) return 'storm';
  return pct >= warnAt ? 'clouds' : 'clear';
}

function logLine(f: FeedItem): string {
  const text = f.text.replace(/\s+/g, ' ').trim();
  const who = f.from === YOU ? 'You' : f.from === 'muster' ? '' : f.from;
  const line = who && !text.toLowerCase().startsWith(who.toLowerCase()) ? `${who}: ${text}` : text;
  return line.length > 90 ? `${line.slice(0, 89)}…` : line;
}

/** Who stands where. With `players` (three idle sailors) the main deck is theirs for the barrel game. */
function layout(state: MusterState, captain: Agent | undefined, question: Note | null, players: Agent[] | null): Pick<ShipView, 'sailors' | 'stuck' | 'below'> {
  const sailors: Sailor[] = [];
  const stuck: ShipView['stuck'] = [];
  let below = 0;
  const free = { main: players ? [] : [...MAIN_DECK], cannon: [...CANNON], stern: [...STERN], rigging: [...RIGGING], rest: [...REST] };
  let nestTaken = false;

  const place = (a: Agent, spot: Spot | undefined, pose: Pose, word?: string): Sailor | null => {
    if (!spot) { below++; return null; }
    const s: Sailor = {
      id: a.id, role: a.role, pose: spot.pose && pose !== 'sit' && pose !== 'stuck' && pose !== 'stand' ? spot.pose : pose,
      x: spot.x, feet: spot.feet, flip: spot.flip, tagLift: spot.tagLift, status: a.status, word: word ?? tagWord(state, a),
    };
    sailors.push(s);
    return s;
  };

  if (captain) place(captain, HELM, question ? 'captain_wave' : 'captain');

  if (players) {
    const [left, right, pilot] = players;
    const { x, feet } = BARREL_LANE;
    place(left, { x: x - PUSHER_GAP, feet }, 'push', 'idle · rolling');
    place(pilot, { x, feet, tagLift: 24 }, 'barrel', 'idle · in the barrel');
    place(right, { x: x + PUSHER_GAP, feet, flip: true, tagLift: 12 }, 'push', 'idle · rolling');
  }

  for (const a of state.agents) {
    if (a === captain || a.status === 'stopped' || a.role === 'research' || players?.includes(a)) continue;
    if (a.status === 'stuck') {
      const s = place(a, free.rigging.shift(), 'stuck');
      if (s) stuck.push({ sailor: s, note: state.notes.find((n) => n.open && n.type === 'stuck' && n.from === a.id) });
      continue;
    }
    if (resting(a)) { place(a, free.rest.shift(), 'sit'); continue; }
    if (a.role === 'design' && !nestTaken) { nestTaken = true; place(a, NEST, 'stand'); continue; }
    const st = station(state, a);
    if (st === 'test' || st === 'qa' || a.role === 'qa') { place(a, free.cannon.shift() ?? free.main.shift() ?? free.stern.shift(), 'stand'); continue; }
    place(a, free.main.shift() ?? free.stern.shift() ?? free.cannon.shift(), 'hammer');
  }
  return { sailors, stuck, below };
}

export function shipView(state: MusterState, config: Pick<MusterConfig, 'warnAtWeeklyPct'>): ShipView {
  const question = captainQuestion(state);
  const fire = blockedMerge(state);
  const chest = awaitingApproval(state);
  const captain = state.agents.find((a) => a.role === 'captain' && a.status !== 'stopped');

  // Three or more idle sailors roll one of them along the main deck in a barrel, as long as nobody working needs the
  // main deck and the treasure chest isn't sitting there.
  const crew = state.agents.filter((a) => a !== captain && a.status !== 'stopped' && a.role !== 'research');
  const players = crew.filter(idle).slice(0, 3);
  const plain = layout(state, captain, question, null);
  let game = players.length === 3 && !chest.length ? layout(state, captain, question, players) : null;
  const onDeck = new Set(game?.sailors.map((s) => s.id));
  if (game && !plain.sailors.every((s) => s.pose === 'sit' || onDeck.has(s.id))) game = null; // someone would be sent below
  const { sailors, stuck, below } = game ?? plain;
  const barrel = game ? { x: BARREL_LANE.x, feet: BARREL_LANE.feet } : null;

  const wk = state.usage.sevenDay ? Math.round(state.usage.sevenDay.usedPercentage) : null;
  const weather = weatherFor(wk, config.warnAtWeeklyPct);
  const anchored = !!state.usage.paused;
  const working = state.agents.filter((a) => a.status === 'working').length;
  const restingCount = state.agents.filter((a) => a !== captain && resting(a)).length;

  const trouble = [fire && 'merge blocked', stuck.length && `${stuck.map((s) => s.sailor.id).join(', ')} stuck`, weather === 'storm' && `usage ${wk}%`].filter(Boolean) as string[];
  const needs = (question ? 1 : 0) + chest.length + (fire ? 1 : 0);
  let tone: ShipView['tone'] = 'ok';
  let title = 'Fair winds';
  let sub = state.agents.length ? `${working} working · ${restingCount} idle · nothing needs you` : 'No crew aboard yet';
  if (trouble.length) {
    tone = 'trouble';
    title = 'Rough seas';
    sub = trouble.join(' · ');
  } else if (needs) {
    tone = 'needs';
    title = `${needs} need${needs === 1 ? 's' : ''} you`;
    sub = [question && 'The Captain has a question', chest.length && `${chest.length} to approve`].filter(Boolean).join(' · ');
  } else if (anchored) {
    title = 'Anchored';
    sub = 'New work is paused until the 5-hour window resets';
  }

  const log = state.feed.filter((f) => f.kind !== 'reply').slice(-2).reverse().map((f) => ({ at: hhmm(f.at), text: logLine(f) }));
  return { sailors, below, question, chest, fire, stuck, barrel, weather, weeklyPct: wk, anchored, tone, title, sub, log };
}
