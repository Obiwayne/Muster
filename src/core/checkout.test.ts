import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MusterState, Task } from '../types.js';
import { inboxFor, isNeedsYou } from './board.js';
import { approvedWaiting, blockedByCheckout, changedPaths, checkoutCleared, openCheckoutNote } from './checkout.js';
import { commitTracked, stashTracked, uncommittedChanges } from './git.js';
import { emptyState } from './store.js';
import { commitFile, gitSync, makeAgent, tempRepo } from './testutil.js';

let s: MusterState;
const task = (id: string, extra: Partial<Task>) => ({ id, title: id, status: 'ready_for_merge', history: [], ...extra }) as unknown as Task;

beforeEach(() => {
  s = emptyState('/repo');
  s.agents.push(makeAgent('captain', 'captain'));
});

describe('merge blocked by the main checkout', () => {
  it('reads paths from porcelain lines, renames by their new name', () => {
    expect(changedPaths([' M assets/a.png', 'M  b.svg', 'R  old.txt -> new.txt', ' M "with space.txt"'])).toEqual(['assets/a.png', 'b.svg', 'new.txt', 'with space.txt']);
  });

  it('posts one open note to you listing the files, and reuses it while it is open', () => {
    const n = blockedByCheckout(s, ['a.png', 'b.svg'], 'T5');
    expect(n).toMatchObject({ topic: 'checkout', to: 'you', taskId: 'T5', open: true });
    expect(isNeedsYou(n)).toBe(true);
    expect(n.text).toMatch(/^Merge blocked: 2 uncommitted files/);
    expect(n.text).toContain('a.png\nb.svg');
    expect(blockedByCheckout(s, ['c.txt']).id).toBe(n.id);
    expect(s.notes).toHaveLength(1);
  });

  it('lists at most 12 files', () => {
    const files = Array.from({ length: 15 }, (_, i) => `f${i}.png`);
    const n = blockedByCheckout(s, files);
    expect(n.text).toContain('f11.png');
    expect(n.text).not.toContain('f12.png');
    expect(n.text).toContain('…and 3 more');
  });

  it('when cleared: closes the note and tells the Captain which approved tasks to merge', () => {
    s.tasks.push(task('T58', { mergeApproval: { at: 'x' } }), task('T60', { mergeApproval: { at: 'x' } }), task('T63', {}));
    blockedByCheckout(s, ['a.png']);
    expect(approvedWaiting(s)).toEqual(['T58', 'T60']);
    expect(checkoutCleared(s, 'committed', 'commit abc123')).toEqual(['T58', 'T60']);
    expect(openCheckoutNote(s)).toBeUndefined();
    const msg = inboxFor(s, 'captain').at(-1)!;
    expect(msg.text).toMatch(/committed the uncommitted files: commit abc123/);
    expect(msg.text).toMatch(/merge_task: T58, T60\.$/);
    expect(blockedByCheckout(s, ['a.png']).id).not.toBe('N1'); // a later block gets a fresh note
  });

  it('sends the Captain nothing when no approved task waits', () => {
    blockedByCheckout(s, ['a.png']);
    checkoutCleared(s, 'stashed', 'git stash pop brings them back');
    expect(inboxFor(s, 'captain')).toHaveLength(0);
  });
});

describe('commitTracked / stashTracked', () => {
  let repo: string;
  beforeEach(() => {
    repo = tempRepo();
    commitFile(repo, 'icon.svg', '<svg/>');
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('commits tracked changes only, and does nothing on a clean tree', async () => {
    expect(await commitTracked(repo, 'nothing')).toBeUndefined();
    writeFileSync(join(repo, 'icon.svg'), '<svg>new</svg>');
    writeFileSync(join(repo, 'scratch.txt'), 'untracked');
    const sha = await commitTracked(repo, 'Update icons');
    expect(sha).toBe(gitSync(repo, 'rev-parse', '--short', 'HEAD'));
    expect(gitSync(repo, 'log', '-1', '--format=%s')).toBe('Update icons');
    expect(await uncommittedChanges(repo)).toEqual([]);
    expect(gitSync(repo, 'status', '--porcelain')).toBe('?? scratch.txt');
  });

  it('stashes tracked changes so stash pop brings them back', async () => {
    expect(await stashTracked(repo, 'x')).toBe(false);
    writeFileSync(join(repo, 'icon.svg'), '<svg>new</svg>');
    expect(await stashTracked(repo, 'Muster: set aside')).toBe(true);
    expect(await uncommittedChanges(repo)).toEqual([]);
    gitSync(repo, 'stash', 'pop');
    expect(readFileSync(join(repo, 'icon.svg'), 'utf8')).toBe('<svg>new</svg>');
  });
});
