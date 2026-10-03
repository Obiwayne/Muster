// Who is calling the API, and what agents may not do. The identity comes from the token only:
// the human token is "you"; an agent token (see core/tokens.ts) is that agent. Any `actor` in a
// request body is overwritten with the resolved identity.
import type { Agent, Role } from '../types.js';
import { HUMAN } from '../core/board.js';
import { deriveAgentToken, sameToken } from '../core/tokens.js';

export interface Caller {
  actor: string; // "you" or an agent id
  human: boolean;
  role?: Role; // the agent's current role
}

export const HUMAN_CALLER: Caller = { actor: HUMAN, human: true };

export class TokenBook {
  private cache = new Map<string, string>();
  constructor(
    readonly humanToken: string,
    private readonly agentSecret: string,
  ) {}

  agentToken(id: string): string {
    let t = this.cache.get(id);
    if (!t) this.cache.set(id, (t = deriveAgentToken(this.agentSecret, id)));
    return t;
  }

  /** The caller behind a token, or null when the token is missing or unknown. */
  resolve(token: string | string[] | undefined | null, agents: readonly Agent[]): Caller | null {
    if (typeof token !== 'string' || !token) return null;
    if (sameToken(token, this.humanToken)) return HUMAN_CALLER;
    for (const a of agents) if (sameToken(token, this.agentToken(a.id))) return { actor: a.id, human: false, role: a.role };
    return null;
  }
}

const HUMAN_ONLY: [string, RegExp, string][] = [
  ['PATCH', /^\/api\/config$/, 'change the config'],
  ['PUT', /^\/api\/stations\/[^/]+$/, 'edit stations'],
  ['DELETE', /^\/api\/stations\/[^/]+$/, 'remove stations'],
  ['PUT', /^\/api\/lines\/[^/]+$/, 'edit lines'],
  ['DELETE', /^\/api\/lines\/[^/]+$/, 'reset or remove lines'],
  ['POST', /^\/api\/shutdown$/, 'shut Muster down'],
  ['POST', /^\/api\/project\/github$/, 'create a GitHub repo'],
  ['POST', /^\/api\/ask$/, 'set the goal'],
  ['POST', /^\/api\/agents\/[^/]+\/role$/, 'change roles'],
  ['DELETE', /^\/api\/agents\/[^/]+$/, 'remove agents'],
  ['POST', /^\/api\/agents\/[^/]+\/input$/, 'type into terminals'],
  ['POST', /^\/api\/agents\/[^/]+\/merge$/, 'merge'],
  ['POST', /^\/api\/tasks\/[^/]+\/approve$/, 'approve'],
  ['POST', /^\/api\/tasks\/[^/]+\/approve-merge$/, 'approve a merge'],
  ['POST', /^\/api\/roadmap\/approve$/, 'approve the roadmap'],
  ['POST', /^\/api\/roadmap\/reject$/, 'send the roadmap back'],
  ['POST', /^\/api\/research\/runs$/, 'start research'],
  ['POST', /^\/api\/research\/runs\/[^/]+\/cancel$/, 'cancel research'],
  ['POST', /^\/api\/research\/ideas\/[^/]+\/(?:ask|approve|reject|reopen)$/, 'decide on research ideas'],
  ['POST', /^\/api\/notes\/[^/]+\/dismiss$/, 'dismiss notes'],
  ['POST', /^\/api\/usage\/weekly-alert$/, 'change the weekly usage alert'],
  ['POST', /^\/api\/intel\/competitors$/, 'add competitors'],
  ['PATCH', /^\/api\/intel\/competitors\/[^/]+$/, 'change competitors'],
  ['DELETE', /^\/api\/intel\/competitors\/[^/]+$/, 'remove competitors'],
  ['POST', /^\/api\/intel\/ask$/, 'ask the Captain about the gaps'],
  ['POST', /^\/api\/intel\/changes\/seen$/, 'mark intel changes seen'],
  ['DELETE', /^\/api\/intel\/watches\/[^/]+$/, 'stop intel watches'],
];

const agentParam = (path: string, re: RegExp): string | undefined => {
  const m = re.exec(path);
  if (!m) return undefined;
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
};

/** Why an agent may not make this request, or undefined when it may. Humans may do everything. */
export function forbiddenReason(caller: Caller, method: string, path: string): string | undefined {
  if (caller.human) return undefined;
  const who = caller.actor;
  for (const [m, re, what] of HUMAN_ONLY) if (m === method && re.test(path)) return `Only you can ${what}; ${who} is an agent`;
  if (method === 'POST') {
    const self = (re: RegExp) => {
      const id = agentParam(path, re);
      return id === undefined || id === who;
    };
    if (!self(/^\/api\/agents\/([^/]+)\/(?:start|stop)$/)) return `${who} may not start or stop other agents`;
    if (!self(/^\/api\/agents\/([^/]+)\/event$/)) return `${who} may only report its own events`;
    if (!self(/^\/api\/inbox\/([^/]+)\/read$/)) return `${who} may only mark its own inbox read`;
    if (caller.role !== 'captain' && !self(/^\/api\/agents\/([^/]+)\/tests$/)) return `Only the Captain runs tests in other worktrees`;
  }
  if (method === 'POST' && caller.role === 'research' && /^\/api\/feed\/[^/]+\/react$/.test(path)) return `The research agent doesn't react on the crew chat`;
  if (method === 'GET' && path === '/api/research/brief' && caller.role !== 'research') return `Only the research agent reads the research brief; ${who} is ${caller.role ?? 'an agent'}`;
  if (method === 'GET' && path === '/api/intel/brief' && caller.role !== 'research') return `Only the research agent reads the intel brief; ${who} is ${caller.role ?? 'an agent'}`;
  if (method === 'GET' && caller.role !== 'captain') {
    const id = agentParam(path, /^\/api\/agents\/([^/]+)\/output$/);
    if (id !== undefined && id !== who) return `Only the Captain reads other agents' terminals`;
  }
  return undefined;
}

/** Stamps the resolved identity over whatever the body claims. */
export function applyIdentity(caller: Caller, path: string, body: Record<string, unknown>): void {
  body.actor = caller.actor;
  if (!caller.human && path === '/api/usage') body.agentId = caller.actor;
}
