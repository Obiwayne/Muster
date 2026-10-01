// Starter guidelines for every station in the built-in lines. Seeded into .muster/stations when the file is
// missing (never overwritten), and used as the fallback text for a station that has no file.
// Each one has the same sections: Purpose / Read first / Produce / Done when / Hand on.
const section = (parts: { purpose: string; read: string[]; produce: string[]; done: string[]; hand: string }): string =>
  [
    '## Purpose',
    parts.purpose,
    '',
    '## Read first',
    ...parts.read.map((l) => `- ${l}`),
    '',
    '## Produce',
    ...parts.produce.map((l) => `- ${l}`),
    '',
    '## Done when',
    ...parts.done.map((l) => `- [ ] ${l}`),
    '',
    '## Hand on',
    parts.hand,
    '',
  ].join(String.fromCharCode(10));

const DOC = 'Write it to docs/factory/<T#>-%.md (T# = this task id) and commit it on the task branch.';

export const STARTER_GUIDELINES: Record<string, string> = {
  discover: section({
    purpose: 'Find out what the task really needs before anyone designs or builds it. You write findings, not code.',
    read: ['The task description and any task it depends on.', 'The code, docs and tests that already cover this area.'],
    produce: [DOC.replace('%', 'discovery') + ' Sections: what exists today, what is unknown, constraints, risks, open questions for the human.', 'No changes outside docs/factory/.'],
    done: ['Every claim in the document points at a file or doc you read.', 'Unknowns are listed as questions, not guessed.', 'The document is committed.'],
    hand: 'Hand on to the concept station with a two-line summary and the questions that matter most.',
  }),
  concept: section({
    purpose: 'Turn the discovery into a concept: two or three options with a recommendation. You write a document, not code.',
    read: ['docs/factory/<T#>-discovery.md from the discover station.', 'The parts of the code the options would touch.'],
    produce: [DOC.replace('%', 'concept') + ' Sections: goal, options with trade-offs and cost, recommendation, what is out of scope.'],
    done: ['Each option says what it changes and what it costs.', 'One option is recommended, with the reason.', 'The document is committed.'],
    hand: 'Hand on to the next station (design or plan) with the recommendation in one line.',
  }),
  plan: section({
    purpose: 'Turn the chosen concept into a plan the Captain can post as build tasks. You write a document, not code.',
    read: ['docs/factory/<T#>-concept.md (and the discovery document).', 'Any design notes from the design station.'],
    produce: [
      DOC.replace('%', 'plan') + ' Sections: approach, order of work, risks, how it is tested.',
      'End the document with a task breakdown: one item per task, each with a title, acceptance criteria and a suggested line (new-app, feature, ui or bugfix).',
    ],
    done: ['Each task is small enough for one branch and one review.', 'Each task has acceptance criteria someone else can check.', 'Each task names a suggested line.', 'The document is committed.'],
    hand: 'Hand on to the approval station: say what you want approved and what you left out.',
  }),
  approval: section({
    purpose: 'You approve this task from the board. Nobody claims this station; the work waits here until you Approve or Reject.',
    read: ['The note on the board and the documents the earlier stations committed under docs/factory/.'],
    produce: ['Approve to move on, or Reject with a note saying what to change (it goes back to the previous station).'],
    done: [
      'The goal in the document is the one you want.',
      'The scope is right: nothing missing, nothing extra.',
      'Risks and open questions have an answer or an owner.',
      'For a plan: each task has acceptance criteria and a sensible line.',
    ],
    hand: 'Approving moves the task to the next station (usually the Captain\'s review). Rejecting sends it back with your note.',
  }),
  design: section({
    purpose: 'Design the screens or flow in Vellum, following the design framework.',
    read: ['The task description and any concept or plan document in docs/factory/.', 'The design framework file in Vellum.'],
    produce: ['Vellum artboards for the change, named after the task.', 'Notes on anything the framework does not cover.'],
    done: ['Every state in the task has an artboard (empty, loading, error, filled).', 'Colours, type and spacing come from the framework.', 'Anything new is called out for the build station.'],
    hand: 'Hand on to the build station with the artboard names and anything the builder must not guess.',
  }),
  build: section({
    purpose: 'Implement the task as described. Keep the change small and reviewable.',
    read: ['The task description and acceptance criteria.', 'Earlier stations\' documents under docs/factory/ and the design artboards, if any.'],
    produce: ['The code change on the task branch, with tests for the new behaviour.'],
    done: ['The acceptance criteria are met.', 'The test command passes.', 'The work is committed.'],
    hand: 'Hand on to the next station with a short note: what changed, how it was tested, anything left open.',
  }),
  test: section({
    purpose: 'Verify the build station\'s work independently and add the tests it missed.',
    read: ['The task description and acceptance criteria.', 'The diff from the build station.'],
    produce: ['Missing tests for the new behaviour, committed on the task branch.', 'A list of anything that fails, with the command and error.'],
    done: ['The full test command passes.', 'Each acceptance criterion has a test or a stated reason it has none.', 'Failures are reported to the builder, not worked around.'],
    hand: 'Hand on with pass or fail per acceptance criterion.',
  }),
  'design-check': section({
    purpose: 'Compare the UI the build station produced against the Vellum design framework and report PASS or DRIFT.',
    read: ['The task description and the design artboards.', 'The design framework file in Vellum.', 'The UI diff.'],
    produce: ['One line per check in the form "PASS <check>" or "DRIFT <check>: what differs and where (file:line)".', 'No edits to the UI; the build station fixes drift.'],
    done: ['Colour, type, spacing, states and copy were each checked.', 'Every DRIFT names the file and what the design says.'],
    hand: 'Hand on with the PASS/DRIFT list. If anything drifted, say so first so the Captain can send it back.',
  }),
  reproduce: section({
    purpose: 'Reproduce the defect with a failing test before anyone fixes it.',
    read: ['The bug report in the task description.', 'The code path it touches and its existing tests.'],
    produce: ['A failing test that shows the defect, committed on the task branch.', 'A note with the exact command and the failure text.'],
    done: ['The test fails for the reason in the report, not for another one.', 'The test is as small as it can be.', 'It is committed.'],
    hand: 'Hand on to the fix station with the command to run and the failing output.',
  }),
  fix: section({
    purpose: 'Fix the defect so the failing test passes, without widening the change.',
    read: ['The failing test and note from the reproduce station.', 'The code path the test exercises.'],
    produce: ['The smallest change that makes the test pass, committed on the task branch.'],
    done: ['The reproducing test passes.', 'The full test command passes.', 'Nothing unrelated changed.'],
    hand: 'Hand on to the test station with the cause in one line and what you changed.',
  }),
};
