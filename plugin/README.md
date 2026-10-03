# Muster skills plugin

Muster starts every agent with `--plugin-dir <Muster>/plugin`, so these skills reach the Captain and crew
(as `muster:<skill>`) without touching your own `~/.claude/skills`. A station names the skills its worker
should use in the `skills:` line of `.muster/stations/<station>.md`; Settings → Edit line shows them.

| Skill | Used at | Source |
|---|---|---|
| `evidence-driven-testing` | the evidence step of every line (test, design-check, reproduce, …) | [michaelshimeles/skills](https://github.com/michaelshimeles/skills) @ 4b72f46 (no licence file; private use) |
| `before-and-after` | UI stations: before/after screenshots | same repo, vendored from [vercel-labs/before-and-after](https://github.com/vercel-labs/before-and-after) (PolyForm Shield 1.0.0, `LICENSE` in the folder) |
| `code-structure` | plan, build, fix | [michaelshimeles/skills](https://github.com/michaelshimeles/skills) @ 4b72f46 |
| `web-research` | discover, concept: web search (Exa), reading pages (Jina Reader), GitHub, YouTube subtitles, RSS; no logins | adapted from [Panniantong/agent-reach](https://github.com/Panniantong/agent-reach) v1.5.0 (MIT, `LICENSE` in the folder) |
| `unslop` | the Captain's notes and summaries for you | same repo, vendored from cursor/plugins pstack (MIT, `LICENSE` in the folder) |

Local edits: `evidence-driven-testing` and `before-and-after` start with an "In Muster" section that
overrides where evidence goes (`.muster-evidence/` + the `add_evidence` tool, never uploaded or posted to a
PR). `before-and-after/scripts/shot.mjs` is Muster's: one headless Chrome/Edge screenshot, the dependable route
on Windows (agent-browser's background browser can hang). The rest of each file is upstream. The upstream
CLI, if wanted: `npm i -g @vercel/before-and-after agent-browser`, then `agent-browser install`.

## web-research setup (once per PC)

```
python -m venv ~/.agent-reach/venv
~/.agent-reach/venv/Scripts/python -m pip install https://github.com/Panniantong/agent-reach/archive/refs/tags/v1.5.0.zip
npm i -g mcporter
mcporter config add exa https://mcp.exa.ai/mcp --scope home
```

Muster appends that venv's `Scripts` folder to the end of each agent's PATH (so `yt-dlp` is found but a
project's own python stays first) and sets `AGENT_REACH_PYTHON`. The skill never runs `agent-reach` itself:
its plain `doctor` copies Agent Reach's own "MUST USE" skill into `~/.claude/skills`. Logged-in channels
(Twitter/X, Reddit, LinkedIn, Facebook, Instagram, Xiaohongshu) are left out on purpose: they read browser
cookies or drive the logged-in browser, which unattended agents shouldn't do with the user's accounts.
Pages behind a login go through Muster's research browser instead (the research agent's read-only `browse`
tool, Settings → Research browser): its own Chrome profile that you sign in to, never your everyday one.
The skill's "Logged-in sites" section tells agents to use only that tool for them.
