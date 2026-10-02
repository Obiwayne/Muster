# Muster skills plugin

Muster starts every agent with `--plugin-dir <Muster>/plugin`, so these skills reach the Captain and crew
(as `muster:<skill>`) without touching your own `~/.claude/skills`. A station names the skills its worker
should use in the `skills:` line of `.muster/stations/<station>.md`; Settings → Edit line shows them.

| Skill | Used at | Source |
|---|---|---|
| `evidence-driven-testing` | the evidence step of every line (test, design-check, reproduce, …) | [michaelshimeles/skills](https://github.com/michaelshimeles/skills) @ 4b72f46 (no licence file; private use) |
| `before-and-after` | UI stations: before/after screenshots | same repo, vendored from [vercel-labs/before-and-after](https://github.com/vercel-labs/before-and-after) (PolyForm Shield 1.0.0, `LICENSE` in the folder) |
| `code-structure` | plan, build, fix | [michaelshimeles/skills](https://github.com/michaelshimeles/skills) @ 4b72f46 |
| `unslop` | the Captain's notes and summaries for you | same repo, vendored from cursor/plugins pstack (MIT, `LICENSE` in the folder) |

Local edits: `evidence-driven-testing` and `before-and-after` start with an "In Muster" section that
overrides where evidence goes (`.muster-evidence/` + the `add_evidence` tool, never uploaded or posted to a
PR). `before-and-after/scripts/shot.mjs` is Muster's: one headless Chrome/Edge screenshot, the dependable route
on Windows (agent-browser's background browser can hang). The rest of each file is upstream. The upstream
CLI, if wanted: `npm i -g @vercel/before-and-after agent-browser`, then `agent-browser install`.
