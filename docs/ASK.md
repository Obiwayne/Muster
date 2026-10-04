# Captain questions on the board and the phone

Claude Code's built-in question menu (the `AskUserQuestion` tool) draws inside the Captain's terminal, where nothing
but the PC sees it, and the Captain sits blocked on a keypress. Muster turns it into a Needs-you note instead, which the
desktop Bulletin board and the phone answer with option buttons.

## Flow

1. Agents' settings (`src/core/claude.ts` `settingsConfig`) route `AskUserQuestion` through the PreToolUse hook
   (add it to `PRE_TOOL_MATCHER`; the guard must keep allowing it).
2. `dist/hooks/hook.js pre-tool` with `tool_name === 'AskUserQuestion'`:
   - Captain (`MUSTER_ROLE=captain`): `POST /api/ask { actor, questions: tool_input.questions }` → Note. Then deny the
     tool with this reason: `Muster sent your question to the user as note <id> (Bulletin board and phone). Do not ask
     again and do not wait: carry on with other work or end your turn. The answer reaches your inbox as a reply on <id>.`
     When the orchestrator can't be reached or answers with an error, print nothing (the terminal menu shows as before).
   - Any other role: deny with `Don't ask the user directly. Use ask_captain(question), or post a question note.`
3. The user answers on the desktop board or the phone → `POST /api/notes/:id/answer` → a reply from "you" closes the
   note and lands in the Captain's inbox (the usual nudge).

## Types (`src/types.ts`)

```ts
export interface AskOption { label: string; description?: string }
export interface AskQuestion { header: string; question: string; multiSelect: boolean; options: AskOption[] }
export interface AskAnswer { header: string; choices: string[]; other?: string }
// on Note:
ask?: AskQuestion[];      // set on an escalation note made by POST /api/ask
answers?: AskAnswer[];    // set when POST /api/notes/:id/answer succeeds
```

## Orchestrator

- `POST /api/ask { actor, questions }`: Captain only (403 otherwise). Validation: 1–4 questions; each has a non-empty
  `question` (≤ 1000 chars), `header` (string, may be empty, trimmed to 40 chars), `multiSelect` (default false) and
  1–6 options with a non-empty `label` (≤ 120) and an optional `description` (≤ 500). Bad input → 400.
  Posts `type 'escalation'`, `to 'you'`, `text` = the questions' `question` lines joined with a blank line, `ask` =
  the cleaned questions. Same desktop notification and toast as `/api/escalate`. Returns the Note.
- `POST /api/notes/:id/answer { actor, answers: [{ choices: string[], other?: string }] }`: human only (403), note must
  have `ask` and be open (409 when closed). One answer per question, by index. Each choice must be one of that
  question's option labels; a single-select question takes at most one choice; every question needs at least one
  choice or a non-empty `other` (≤ 1000). Stores `answers` (with each question's header) and replies as "you" with
  `close: true`. Reply text, one line per question: `<header or "Q<n>">: <choices joined with ", ">` plus
  ` (note: <other>)` when both are given, or just `<other>` when there are no choices. Returns the Note.
- A free-text reply on an ask note (`/api/notes/:id/reply`) still works and does not close it.

## Captain prompt (`src/prompts/index.ts`)

Say that the built-in question menu reaches the user on the Bulletin board and the phone, is the right way to put a
multiple-choice decision to them (2–4 short options with a one-line description each, recommended first), and that once
Muster says the question was sent the Captain carries on or ends its turn and acts on the reply when it arrives.

## Phone gateway (`src/phone`) and `docs/PHONE.md`

- `NeedItem.ask?: AskQuestion[]` on escalation items made from an ask note; their `title` is `The Captain asks you`,
  `summary` the first question. Actions stay `['answer', 'open']`.
- `POST /api/projects/:pid/notes/:nid/answer { answers }` → orchestrator `POST /api/notes/:nid/answer` as you.
- `GET /api/projects/:pid/notes/:nid` already returns the Note, so `ask` and `answers` come along.

## Desktop Bulletin board (`ui/src/pages/board.ts`)

An open ask note shows each question as: header chip, question text, option rows (label + muted description; radio for
single-select, checkbox for multi-select), an "Other…" text field, then one Submit that calls the answer route. The
first option carries a "Recommended" tag only when its label ends in "(Recommended)" (strip that from the label shown).
The free-text reply box stays below as "Or reply in your own words". A closed ask note shows the chosen answers.

## Android (`android/`)

- `Note.ask`, `Note.answers`, `NeedItem.ask` in Models.kt; `answer(pid, nid, answers)` in the backend/API.
- M06 Answer screen: when the note has `ask`, show each question (header chip, question, option cards with label and
  description, radio or checkbox, "Type something" field) and a captain-amber Submit button that is enabled once every
  question has a choice or text. Keep the free-text reply row below ("Or reply in your own words"). Answered or closed
  notes show the answers read-only.
- Notifications: an item with `ask` that has exactly one single-select question with ≤ 3 options gets one action per
  option (label trimmed to 24 chars, `setAuthenticationRequired(true)`), which calls the answer route with that choice;
  otherwise the existing REPLY + OPEN actions. The notification body shows the question and the option labels.
- Demo backend: add the Art model / Caption size example (two questions, 3 options each, descriptions).
