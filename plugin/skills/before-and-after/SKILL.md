---
name: before-and-after
description: Captures before/after screenshots of web pages or elements for visual comparison. Use when user says "take before and after", "screenshot comparison", "visual diff", "PR screenshots", "compare old and new", or needs to document UI changes. Accepts two URLs (file://, http://, https://) or two image paths.
allowed-tools:
  - Bash(npx @vercel/before-and-after *)
  - Bash(before-and-after *)
  - Bash(which before-and-after)
  - Bash(npm install -g @vercel/before-and-after)
  - Bash(*/upload-and-copy.sh *)
  - Bash(curl -s -o /dev/null -w *)
  - Bash(gh pr view *)
  - Bash(gh pr edit *)
  - Bash(vercel inspect *)
  - Bash(vercel whoami)
  - Bash(which vercel)
  - Bash(which gh)
---

## In Muster (overrides the rest of this file)

- Never upload. Skip the upload step and `--markdown`; keep the PNGs local in
  `.muster-evidence/<task id>/` inside your worktree and attach them with the muster tool
  `add_evidence(files, summary)`. The review card shows them side by side.
- "Before" is the base branch, "after" is your worktree. If you need both running, start them on two free
  ports and check each one serves the right checkout. Or capture "before" first, before you change
  anything, and "after" when you are done (the CLI takes two image paths too).
- Name the pair `NN-before-<what>.png` / `NN-after-<what>.png` so the card pairs them.
- **Take the shots with `node <this skill's folder>/scripts/shot.mjs <url-or-file> <out.png> [--size 1280x800] [--wait 1500]`.**
  It drives headless Chrome or Edge directly and returns in a couple of seconds. The `before-and-after`
  CLI below needs agent-browser's background browser, which can hang on this machine: if you try it
  and it hasn't finished in 30 s, stop it and use `shot.mjs`.
- Pages that need clicks or typing first: a Playwright script
  (`npx --yes --package=playwright node <script>.mjs`, see `muster:evidence-driven-testing`).

### Demo recording (a Media demo GIF)

When your task is to record a demo for the Media page, the brief gives you the steps:
- Run the app with **sample data only** (seeded test accounts, made-up names); never real users or real classes.
- Write the steps as code in `.muster-evidence/<task id>/actions.mjs`:
  `export default async (page) => { await page.click('text=Approve'); await page.waitForTimeout(800); }`.
  Pause 0.5–1 s between steps so a viewer can follow, and keep the whole demo under 30 seconds.
- Record it: `node <this skill's folder>/scripts/record.mjs <url> .muster-evidence/<task id>/demo.webm .muster-evidence/<task id>/actions.mjs [--size 1280x800] [--hold 1200]`.
  It uses the same Chrome or Edge as `shot.mjs`, and Playwright from Muster's own install.
- Attach the video with `add_evidence(files: [".muster-evidence/<task id>/demo.webm"], summary)`. Muster turns it into
  the GIF with the frame captions and tells the user. A screen recorder's .mp4 or a ready .gif works too.


# Before-After Screenshot Skill

> **Package:** `@vercel/before-and-after`
> Never use `before-and-after` (wrong package).

## Agent Behavior Rules

**DO NOT:**
- Switch git branches, stash changes, start dev servers, or assume what "before" is
- Use `--full` unless user explicitly asks for full page / full scroll capture

**DO:**
- Use `--markdown` when user wants PR integration or markdown output
- Use `--mobile` / `--tablet` if user mentions phone, mobile, tablet, responsive, etc.
- Assume current state is **After**
- If user provides only one URL or says "PR screenshots" without URLs, **ASK**: "What URL should I use for the 'before' state? (production URL, preview deployment, or another local port)"

## Execution Order (MUST follow)

1. **Pre-flight** — `which before-and-after || npm install -g @vercel/before-and-after`
2. **Protection check** — if `.vercel.app` URL: `curl -s -o /dev/null -w "%{http_code}" "<url>"` (401/403 = protected)
3. **Capture** — `before-and-after "<before-url>" "<after-url>"`
4. **Upload** — `./scripts/upload-and-copy.sh <before.png> <after.png> --markdown`
5. **PR integration** — optionally `gh pr edit` to append markdown

**Never skip steps 1-2.**

## Quick Reference

```bash
# Basic usage
before-and-after <before-url> <after-url>

# With selector
before-and-after url1 url2 ".hero-section"

# Different selectors for each
before-and-after url1 url2 ".old-card" ".new-card"

# Viewports
before-and-after url1 url2 --mobile    # 375x812
before-and-after url1 url2 --tablet    # 768x1024
before-and-after url1 url2 --full      # full scroll

# From existing images
before-and-after before.png after.png --markdown

# Via npx (use full package name!)
npx @vercel/before-and-after url1 url2
```

| Flag | Description |
|------|-------------|
| `-m, --mobile` | Mobile viewport (375x812) |
| `-t, --tablet` | Tablet viewport (768x1024) |
| `--size <WxH>` | Custom viewport |
| `-f, --full` | Full scrollable page |
| `-s, --selector` | CSS selector to capture |
| `-o, --output` | Output directory (default: ~/Downloads) |
| `--markdown` | Upload images & output markdown table |
| `--upload-url <url>` | Custom upload endpoint (default: 0x0.st) |

## Image Upload

```bash
# Default (0x0.st - no signup needed)
./scripts/upload-and-copy.sh before.png after.png --markdown

# GitHub Gist
IMAGE_ADAPTER=gist ./scripts/upload-and-copy.sh before.png after.png --markdown
```

## Vercel Deployment Protection

If `.vercel.app` URL returns 401/403:

1. Check Vercel CLI: `which vercel && vercel whoami`
2. If available: `vercel inspect <url>` to get bypass token
3. If not: Tell user to provide bypass token, take manual screenshots, or disable protection

## PR Integration

```bash
# Check for gh CLI
which gh

# Get current PR
gh pr view --json number,body

# Append screenshots to PR body
gh pr edit <number> --body "<existing-body>

## Before and After
<generated-markdown>"
```

If no `gh` CLI: output markdown and tell user to paste manually.

## Error Reference

| Error | Fix |
|-------|-----|
| `command not found` | `npm install -g @vercel/before-and-after` |
| `could not determine executable` | Use `npx @vercel/before-and-after` (full name) |
| 401/403 on .vercel.app | See Vercel protection section |
| Element not found | Verify selector exists on page |
