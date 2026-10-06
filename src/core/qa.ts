// The QA gate: every task passes the locked `qa` station (worked by the standing QA agent) before review.
// A diff that only touches docs or images skips it.
import type { Task } from '../types.js';

export const QA_STATION = 'qa';
export const QA_ID = 'qa'; // the one QA agent; it doesn't count toward maxCrew

const DOC_OR_IMAGE = /\.(md|mdx|rst|png|jpe?g|gif|webp|svg|ico|bmp)$/i;
const DOC_NAMES = /^(license|licence|notice|changelog|authors|contributing)$/i;

/** True when every changed file is documentation or an image (an empty change has nothing to QA either). */
export function qaSkippable(files: string[]): boolean {
  return files.every((f) => {
    const name = f.replace(/[\\]/g, '/').split('/').pop() ?? f;
    return DOC_OR_IMAGE.test(name) || DOC_NAMES.test(name);
  });
}

/** Task.qa after a QA pass was recorded: the round count only goes up. */
export const qaRound = (task: Pick<Task, 'qa'>): number => task.qa?.round ?? 0;
