---
name: web-research
description: Research on the public internet for a task that asks for it (a discover or concept station, or a brief that says to look something up) - web search, reading pages, GitHub, YouTube videos and subtitles, RSS feeds. No logins. Not for coding stations that just happen to mention a URL.
---

# Web research (no logins)

Adapted from [Agent Reach](https://github.com/Panniantong/agent-reach) v1.5.0 (MIT, `LICENSE` in this
folder), cut down to the channels that need no account. Its tools are installed on this PC:
`mcporter` (Exa search), `curl`, `gh`, and Agent Reach's Python environment, whose `yt-dlp` is on your
PATH and whose python is `$AGENT_REACH_PYTHON` (it has `feedparser`).

## Rules

- **Public sources only with these tools.** Never log in to anything, never read or export browser
  cookies, never drive a browser of your own. If something is behind a login (Twitter/X, Reddit, LinkedIn,
  Facebook, Instagram, Xiaohongshu), use the muster `browse` tool if you have it (see "Logged-in sites"
  below); otherwise say so in your notes and work from public sources instead.
- **Queries leave this PC.** Exa and Jina Reader are outside services: they see what you search and the
  URLs you read. Search for the topic, never paste the project's private code, names or plans into a query.
- **Don't run the `agent-reach` command itself.** Its `doctor`/`install` copy a skill into the user's own
  `~/.claude/skills`. The tools below are all you need. (`agent-reach doctor --json` is the only safe
  form, if you must check what works.)
- **Cite everything.** Every finding gets its URL (and the date when the page has one). Separate what a
  source says from what you conclude.
- **Write it down.** Findings go into the document your station produces (e.g. `docs/factory/T#-discovery.md`),
  not just into chat. When the brief asks for evidence, attach that document with `add_evidence`.
- Read a few strong sources fully rather than skimming many. Stop when more sources stop changing the answer.

## Search the web (Exa)

```bash
mcporter call exa.web_search_exa query="open source multi-agent coding orchestrators" numResults=5
mcporter call exa.web_search_exa query="<library> API example" numResults=5
```

Good for English and technical content. For code inside repositories, use GitHub search below.

## Read a page (Jina Reader)

```bash
curl -s "https://r.jina.ai/https://example.com/article"
```

Returns the page as Markdown. Long pages: pipe through `head -c 20000` and read on if it matters.
If Jina fails for a page, `curl -sL <url>` gives the raw HTML. Jina is refused (403) on github.com pages:
read GitHub through `gh` below, or a raw file through `https://raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>`.

## GitHub (gh, signed in)

```bash
gh search repos "query" --sort stars --limit 10
gh search code "query" --language typescript --limit 10
gh repo view owner/repo
gh api repos/owner/repo/readme --jq .content | base64 -d    # a README
gh issue list -R owner/repo --state open --limit 20          # what users ask for / complain about
gh release list -R owner/repo --limit 5
```

Read only. Never fork, star, open issues or PRs, or comment.

## YouTube (yt-dlp)

```bash
# search: title and URL of the top results
yt-dlp --flat-playlist --print "%(title)s | %(channel)s | %(url)s" "ytsearch5:query"

# what a video says: subtitles only, no video download (write them outside your worktree)
yt-dlp --js-runtimes node --write-sub --write-auto-sub --sub-lang en --sub-format vtt --skip-download -o "$TEMP/%(id)s" "URL"

# title, channel, date, description, chapters
yt-dlp --js-runtimes node --dump-json --skip-download "URL"
```

Auto subtitles repeat lines; strip the timing tags and duplicates before quoting. No subtitles: say so,
work from the description and chapters. Never download the video itself. Don't use yt-dlp for Bilibili.

## RSS / Atom feeds

```bash
"$AGENT_REACH_PYTHON" -c "import feedparser,sys; f=feedparser.parse(sys.argv[1]); [print(e.get('published',''), '|', e.title, '|', e.link) for e in f.entries[:10]]" "https://github.blog/feed/"
```

## Logged-in sites (the muster `browse` tool)

The research agent (scout) has a `browse` MCP tool during an intel job or research run. It reads pages
through Muster's own research browser profile, which the human signed in to (Settings → Research browser),
so Reddit threads, LinkedIn company pages and similar pages behind a login can be read.

- **Pages behind a login go only through `browse`.** Never through cookies, cookie export tools
  (browser_cookie3, rookiepy, `agent-reach` cookie commands), a browser profile, Playwright or a Chrome you
  start yourself. The guard refuses those commands anyway.
- **Read-only.** `browse(url, action)` with `read` (text, optional `links`), `screenshot` (a PNG you open
  with Read) or `scroll` (then `read` again to see what loaded). It can't post, like, follow, message,
  connect or fill in anything, and you never try to.
- **Rate-limited and budgeted.** Pages on one site are spaced out and each job has a page budget; when it
  says the budget is used, finish with what you have.
- **Public pages still come first.** Use the tools above (Jina, Exa, `gh`, RSS) for anything public, and
  official data before logged-in pages: Companies House, store pages, public roadmaps, RSS.
- If a page needs a login the profile doesn't have (the result says `loggedIn: false`, or the page is a
  sign-in or "prove you're human" screen), say so in your summary; don't work around it.
- **Bot checks:** when a site answers the research browser with a bot check ("Just a moment…", 403/429),
  the result carries `blocked` and `browse` reads the public page through the Jina Reader (or a plain
  cookie-less request) instead, with `readVia: "public_reader"`. Never retry to get past the check. Title
  that source "… (read via public reader (site blocked the research browser))".
- Sources read this way carry `via` (profile/opera) when you record them.

## When a channel fails

1. Exa error or empty: try a different wording once, then fall back to `gh search` or reading known pages.
2. Jina error: `curl -sL` the page, or find another source.
3. yt-dlp bot check or no subtitle file: retry once; then use `--dump-json` (description, chapters) and say
   the subtitles weren't available.

Report what didn't work in your notes instead of guessing at what a source says.
