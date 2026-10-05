import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import type { AskQuestion } from '../../src/types';
import { repoKey } from '../../src/core/tokens';
import {
  answerViews, askedAgo, exactLabel, failedText, fmtLeft, forProject, heldTitle, isExpired, isWarm, lockText, msLeft, projectKeyInput,
  recipients, recipientText, rowMeta, rowText, sendLabel, sortHeld, type PendingRemote,
} from './remotemodel';

const NOW = Date.parse('2026-10-05T22:00:00Z');
const at = (min: number) => new Date(NOW + min * 60_000).toISOString();
const held = (extra: Partial<PendingRemote> = {}): PendingRemote => ({
  id: 'P8', pendingId: 'P8', projectId: 'abc123', projectName: 'wall-education', client: 'Claude', kind: 'reply', noteId: 'N12',
  text: "Go with 7 days, and show the friendly 'link expired' page.", replyTo: { id: 'N12', from: 'ada', text: 'Should invite links expire after 7 days or 30?' },
  createdAt: at(-13), expiresAt: at(2), digest: 'd1', title: 'Claude wants to reply on N12', summary: '', ...extra,
});

describe('countdown', () => {
  it('formats m:ss, rounding up so it never shows 0:00 early', () => {
    expect(fmtLeft(138_000)).toBe('2:18');
    expect(fmtLeft(652_000)).toBe('10:52');
    expect(fmtLeft(400)).toBe('0:01');
    expect(fmtLeft(0)).toBe('0:00');
    expect(fmtLeft(-5000)).toBe('0:00');
  });

  it('turns warm under 3 minutes and expires at 0', () => {
    const p = held();
    expect(msLeft(p, NOW)).toBe(120_000);
    expect(isWarm(msLeft(p, NOW))).toBe(true);
    expect(isWarm(3 * 60_000)).toBe(false);
    expect(isWarm(0)).toBe(false);
    expect(isExpired(p, NOW)).toBe(false);
    expect(isExpired(p, NOW + 120_000)).toBe(true);
  });

  it('says when it was asked', () => {
    expect(askedAgo(at(-13), NOW)).toBe('asked 13 min ago');
    expect(askedAgo(at(-0.2), NOW)).toBe('asked just now');
    expect(askedAgo(at(-130), NOW)).toBe('asked 2 h ago');
  });
});

describe('what the card says', () => {
  it('titles each kind, and in the past once it is over', () => {
    expect(heldTitle(held())).toBe('Claude wants to reply on N12');
    expect(heldTitle(held(), { past: true })).toBe('Claude wanted to reply on N12');
    expect(heldTitle(held({ kind: 'goal', noteId: undefined, replyTo: undefined }))).toBe('Claude wants to give the Captain a goal');
    expect(heldTitle(held({ kind: 'answer', noteId: 'N15', answers: [{ choices: ['a'] }, { choices: ['b'] }, { other: 'c' }], replyTo: { id: 'N15', from: 'captain', text: 'q' } })))
      .toBe("Claude wants to answer the Captain's 3 questions on N15");
    expect(heldTitle(held({ kind: 'answer', noteId: 'N15', answers: [{ choices: ['a'] }], replyTo: { id: 'N15', from: 'ada', text: 'q' } })))
      .toBe("Claude wants to answer ada's question on N15");
    expect(heldTitle(held({ kind: 'approve', taskId: 'T3' }))).toBe('Claude wants to approve T3 for merge');
  });

  it('rows carry the full text, never clipped', () => {
    const long = 'x'.repeat(900);
    expect(rowText(held({ text: long }))).toBe(`Claude wants to reply on N12: ${long}`);
    expect(rowText(held({ kind: 'answer', answers: [{ choices: ['MP4 (H.264)', 'WebM'] }, { choices: ['1080p'] }, { other: 'line 1\nline 2' }] })))
      .toBe("Claude wants to answer ada's 3 questions on N12: MP4 (H.264), WebM · 1080p · line 1\nline 2");
  });

  it('names the recipients: goal → captain, reply/answer → note author + captain, approve → task', () => {
    expect(recipients(held()).map((r) => r.id)).toEqual(['ada', 'captain']);
    expect(recipientText(held())).toBe('ada and the Captain');
    expect(recipients(held({ replyTo: { id: 'N16', from: 'captain', text: 'q' } })).map((r) => r.id)).toEqual(['captain']);
    expect(recipients(held({ kind: 'goal', replyTo: undefined })).map((r) => r.id)).toEqual(['captain']);
    expect(recipients(held({ kind: 'approve', taskId: 'T3', taskTitle: 'Invite API' }))).toEqual([{ id: 'T3', kind: 'task', label: 'T3 Invite API' }]);
    expect(rowMeta(held())).toBe('P8 · from Claude · to ada and the Captain');
    expect(recipients(held(), 'cap-1').map((r) => r.id)).toEqual(['ada', 'cap-1']);
  });

  it('labels Send and the callout by kind', () => {
    expect(sendLabel(held())).toBe('Send reply');
    expect(sendLabel(held({ kind: 'answer', answers: [{}, {}] }))).toBe('Send answers');
    expect(sendLabel(held({ kind: 'goal' }))).toBe('Send goal');
    expect(lockText(held())).toBe('This text is locked. It reaches ada and the Captain, and shows in crew chat as yours via Claude, only when you press Send.');
    expect(lockText(held({ kind: 'answer', answers: [{}, {}, {}], replyTo: { id: 'N15', from: 'captain', text: '' } })))
      .toBe('These answers are locked. They reach the Captain, and show in crew chat as yours via Claude, only when you press Send.');
    expect(exactLabel(held())).toBe('WILL SEND EXACTLY THIS');
    expect(exactLabel(held({ kind: 'answer', answers: [{}, {}, {}] }))).toBe('WILL SEND EXACTLY THESE 3 ANSWERS');
    expect(exactLabel(held(), true)).toBe('WAS NOT SENT');
  });

  it('shows every answer with its question from the note menu, keeping free text as is', () => {
    const ask: AskQuestion[] = [
      { header: 'Export', question: 'Which formats?', multiSelect: true, options: [] },
      { header: '', question: 'Default resolution?', multiSelect: false, options: [] },
    ];
    const p = held({ kind: 'answer', answers: [{ choices: ['MP4', 'WebM'] }, { choices: ['1080p'], other: 'a\n\nb' }, { other: 'third' }] });
    expect(answerViews(p, ask)).toEqual([
      { n: 1, question: 'Export: Which formats?', choices: ['MP4', 'WebM'], other: '' },
      { n: 2, question: 'Default resolution?', choices: ['1080p'], other: 'a\n\nb' },
      { n: 3, question: 'Answer 3', choices: [], other: 'third' },
    ]);
  });

  it('keeps the server reason in the failed callout', () => {
    expect(failedText('captain is not running')).toBe("captain is not running. It's still held, unchanged. Try again, or discard it.");
    expect(failedText('P8 is not what your screen showed; reload and check it again. Nothing was sent.'))
      .toBe("P8 is not what your screen showed; reload and check it again. Nothing was sent. It's still held, unchanged. Try again, or discard it.");
  });

  it('sorts soonest-to-expire first', () => {
    expect(sortHeld([held({ pendingId: 'P1', expiresAt: at(9) }), held({ pendingId: 'P2', expiresAt: at(1) })]).map((p) => p.pendingId)).toEqual(['P2', 'P1']);
  });
});

describe('which project', () => {
  it('normalises the root like repoKey on Windows and POSIX', () => {
    expect(projectKeyInput('F:\\Muster\\')).toBe('f:/muster');
    expect(projectKeyInput('C:/Users/Wayne/Proj')).toBe('c:/users/wayne/proj');
    expect(projectKeyInput('/work/Acme-App/')).toBe('/work/Acme-App');
  });

  it('hashes to the gateway project id (repoKey) for a Windows root', () => {
    const id = (root: string) => createHash('sha256').update(projectKeyInput(root)).digest('hex').slice(0, 16);
    expect(id('F:\\Muster-remote-board')).toBe(repoKey('F:\\Muster-remote-board', 'win32'));
    expect(id('C:\\Users\\Wayne\\My App\\')).toBe(repoKey('C:\\Users\\Wayne\\My App\\', 'win32'));
  });

  it('matches by project id, or by name when the id is unknown', () => {
    const list = [held({ pendingId: 'P1', projectId: 'aaa', projectName: 'x' }), held({ pendingId: 'P2', projectId: 'bbb', projectName: 'x' })];
    expect(forProject(list, { id: 'bbb', name: 'x' }).map((p) => p.pendingId)).toEqual(['P2']);
    expect(forProject(list, { id: null, name: 'x' }).map((p) => p.pendingId)).toEqual(['P1', 'P2']);
    expect(forProject(list, { id: null, name: 'y' })).toEqual([]);
  });
});
