// Intel → Reviews & social (6138-0): complaint themes counted within the reviewed sample (thin themes kept apart),
// what they love, the social channel grid, complaints in their comments, what gets engagement and where we can win.
import type { IntelSocialChannel, IntelStore, IntelTheme } from '../../../src/types';
import { h, icon, promptDialog, setChildren } from '../dom';
import { run as runAction } from '../actions';
import { askIntel } from '../intelapi';
import {
  SEVERITY_TEXT, THIN_SOURCES, TREND_TEXT, companyColour, companyName, compact, complaintThemes, fmtDate, isThin, loveThemes, rivals,
  sampleLine, shareOfSample, themeTag, themesFor,
} from '../intelmodel';
import { caption, claimLine, emptyState, labelDot, openSources, segmented, type IntelCtx } from './common';

let who: string = 'all';
let openTheme: string | null = null;

const CHANNELS: { id: IntelSocialChannel['channel']; label: string }[] = [
  { id: 'youtube', label: 'YouTube' }, { id: 'tiktok', label: 'TikTok' }, { id: 'instagram', label: 'Instagram' }, { id: 'linkedin', label: 'LinkedIn' },
  { id: 'x', label: 'X' }, { id: 'facebook', label: 'Facebook' }, { id: 'reddit', label: 'Reddit' },
];

export function renderReviews(host: HTMLElement, ctx: IntelCtx): void {
  const store = ctx.intel;
  if (!rivals(store).length) {
    setChildren(host, h('div.it-pad', null, emptyState('No competitors tracked yet', 'Add a competitor with Reviews & pain points ticked, and scout reads their reviews, forums and social comments.', { label: 'Add competitor', onClick: ctx.addCompetitor })));
    return;
  }
  setChildren(host, h('div.it-split', null, complaintsColumn(host, ctx), socialColumn(store)));
}

// ---------------------------------------------------------------- complaints

function complaintsColumn(host: HTMLElement, ctx: IntelCtx): HTMLElement {
  const store = ctx.intel;
  const comps = rivals(store);
  if (who !== 'all' && !comps.some((c) => c.id === who)) who = 'all';
  const scoped = themesFor(store.themes, who === 'all' ? null : who);
  const themes = complaintThemes(scoped);
  const love = loveThemes(scoped);
  const thin = scoped.filter((t) => isThin(t));
  const expanded = themes.find((t) => t.id === openTheme) ?? themes[0];
  // "Why they switch away" (win them over) rows sit at the bottom of the list, as in the design.
  const rest = themes.filter((t) => t !== expanded).sort((a, b) => Number(a.ourAnswer?.kind === 'win_over') - Number(b.ourAnswer?.kind === 'win_over'));
  const s = store.sample;
  const rerender = () => renderReviews(host, ctx);

  return h('div.it-col', null,
    h('div.it-sec-head', null,
      h('div.it-sec-titles', null,
        h('div.it-sec-t', null, 'What their customers complain about'),
        h('div.it-sec-s', null, s ? `${sampleLine(s, ' · ')} · grouped by scout` : 'no reviewed sample yet')),
      segmented<string>([{ value: 'all', label: 'All' }, ...comps.map((c) => ({ value: c.id, label: c.name }))], who, (v) => { who = v; openTheme = null; rerender(); }, 'md')),
    s ? h('div.it-sample', null, s.counts.map((c) => h('span.it-sample-chip', null, h('span', null, c.label), h('span.n', null, String(c.n))))) : null,
    expanded ? themeCard(ctx, expanded) : h('div.it-empty', null,
      h('div.it-empty-t', null, store.themes.length ? 'Only thin evidence so far' : 'No reviews read yet'),
      h('div.it-empty-s', null, store.themes.length
        ? `No complaint theme has ${THIN_SOURCES}+ independent sources${who === 'all' ? '' : ` for ${companyName(store, who)}`} yet, so none is shown as a finding.`
        : "scout hasn't read their reviews yet. Run a sweep with Reviews & pain points ticked.")),
    rest.length ? h('div.it-tlist', null, rest.map((t) => themeRow(t, () => { openTheme = t.id; rerender(); }))) : null,
    love.length ? h('button.it-love', { onclick: (e: MouseEvent) => openSources(e.currentTarget as HTMLElement, 'What they love', love[0]!.sources, love[0]) },
      h('div.it-love-k', null, 'WHAT THEY LOVE'),
      h('div.it-love-t', null, love.map((l) => l.title).join(' · ')),
      h('div.it-love-s', null, love[0]!.implication ? 'customers will expect this' : `${shareOfSample(love[0]!)}% of sample`)) : null,
    thin.length ? h('div.it-thin', null,
      h('div.section-label', null, `THIN EVIDENCE · ${thin.length}`),
      thin.map((t) => h('div.it-thin-row', null,
        h('span.flex1', null, t.title),
        h('span.faint', null, `${t.mentions} mentions · ${t.independentSources} independent source${t.independentSources === 1 ? '' : 's'}`),
        h('span.it-tag.watch', null, 'thin evidence')))) : null,
    caption(`Customer opinion. Percentages are of the reviewed sample, not all customers. A theme needs ${THIN_SOURCES}+ independent sources before it's shown.`));
}

function themeCard(ctx: IntelCtx, t: IntelTheme): HTMLElement {
  const tag = themeTag(t);
  const answer = t.ourAnswer;
  const trendCls = t.trend === 'rising' ? 'warm' : t.trend === 'easing' ? 'ok' : '';
  const fact = (label: string, value: string, cls = '') => h('div.it-fact', null, h('div.it-fact-l', null, label), h('div.it-fact-v', { class: cls }, value));
  const ask = h('button.btn.sm.it-ask', null, 'Ask Captain');
  ask.onclick = async () => {
    const text = await promptDialog('Ask the Captain', `About “${t.title}” (${shareOfSample(t)}% of the reviewed sample).`, 'Ask', 'What would it take to answer this?');
    if (!text) return;
    if (await runAction(askIntel(`${t.title} (${t.id}): ${text}`, answer?.ideaId), 'Asked the Captain')) ctx.refresh();
  };
  return h('div.it-theme', { class: `s-${t.severity}` },
    h('div.it-theme-head', null,
      h('div.it-theme-t', null, t.title),
      h('span.it-sev', { class: `s-${t.severity}` }, SEVERITY_TEXT[t.severity])),
    h('div.it-facts', null,
      fact('Of sample', `${shareOfSample(t)}% · ${t.mentions}`, 'mono'),
      fact('Trend', `${TREND_TEXT[t.trend].split(' ')[0]} ${t.trendNote ?? t.trend}`, trendCls),
      t.who ? fact('Who', t.who) : null,
      t.workaround ? fact('Workaround', t.workaround) : null),
    t.quotes.slice(0, 6).map((q) => {
      const qEl = h('button.it-quote', { title: 'Open the source' },
        h('div.it-quote-t', null, `“${q.text}”`),
        h('div.it-quote-s', null, [q.source.title, fmtDate(q.source.publishedAt ?? q.source.seenAt)].filter(Boolean).join(' · ')));
      qEl.onclick = () => openSources(qEl, 'Quote source', [q.source]);
      return qEl;
    }),
    h('div.it-theme-foot', null,
      answer ? h('div.it-answer', { class: `a-${answer.kind}` },
        answer.kind === 'watch' ? icon('alert', 12) : h('span.it-up'),
        h('span', null, answer.text, answer.ideaId && !answer.text.includes(answer.ideaId) ? ` (${answer.ideaId})` : '', answer.goalId ? ` · ${answer.goalId}` : ''))
        : tag ? h('span.it-tag', { class: tag.cls }, tag.text) : h('div.flex1'),
      ask),
    h('div.it-theme-claim', null, claimLine(t, t.title), h('span.faint', null, ` · ${t.independentSources} independent sources`)));
}

function themeRow(t: IntelTheme, onOpen: () => void): HTMLElement {
  const tag = themeTag(t);
  const winOver = t.ourAnswer?.kind === 'win_over';
  return h('button.it-trow', { class: winOver && 'win', onclick: onOpen, title: `${t.mentions} mentions · ${t.independentSources} independent sources` },
    h('div.it-trow-t', null, labelDot(t.label), h('span', null, t.title)),
    h('div.it-trow-n', null, winOver ? String(t.mentions) : `${shareOfSample(t)}%`),
    h('div.it-trow-trend', { class: winOver ? '' : t.trend }, winOver ? 'mentions' : TREND_TEXT[t.trend]),
    h('div.it-trow-tag', null, tag ? h('span.it-tag', { class: tag.cls }, tag.text) : null));
}

// ---------------------------------------------------------------- social

function socialColumn(store: IntelStore): HTMLElement {
  const comps = rivals(store);
  const rows = CHANNELS.filter((ch) => store.social.some((s) => s.channel === ch.id));
  const checked = store.social.map((s) => s.asOf).sort().pop();
  const complaints = store.socialInsights.filter((s) => s.kind === 'comment_complaint');
  const engagement = store.socialInsights.filter((s) => s.kind === 'engagement');
  const wins = store.socialInsights.filter((s) => s.kind === 'win');
  const commentCount = store.sample?.counts.find((c) => c.kind === 'social_comments')?.n;

  const cell = (s: IntelSocialChannel | undefined, channel: string) => {
    if (!s) return h('div.it-sg-c', null, h('div.it-sg-v.faint', null, '?'), h('div.it-sg-s', null, 'not checked'));
    const el = h('button.it-sg-c', { title: 'Show sources' });
    el.onclick = () => openSources(el, `${companyName(store, s.competitorId)} · ${channel}`, s.sources, s);
    if (s.replies) {
      const [main, ...more] = s.replies.split(' · ');
      setChildren(el, h('div.it-sg-v.text', null, main),
        h('div.it-sg-s', { class: /unanswered|no repl/i.test(more.join(' ')) && 'warm' }, more.join(' · ') || '—'));
    } else if (s.presence === 'absent') {
      setChildren(el, h('div.it-sg-v.faint', { class: channel === 'Reddit' && 'text' }, channel === 'Reddit' ? 'Absent' : '—'), h('div.it-sg-s', { class: channel !== 'Reddit' && 'ok' }, channel === 'Reddit' ? '—' : 'not on it'));
    } else if (s.presence === 'dormant') {
      setChildren(el, h('div.it-sg-v.faint', null, compact(s.followers)), h('div.it-sg-s.bad', null, `dormant${s.dormantFor ? ` ${s.dormantFor}` : ''}`));
    } else {
      const small = (s.followers ?? 0) < 1000;
      setChildren(el, h('div.it-sg-v', { class: small && 'faint' }, small && s.followers !== undefined ? `${(s.followers / 1000).toFixed(1)}k` : compact(s.followers)),
        h('div.it-sg-s', null, [s.cadence, s.contentType].filter(Boolean).join(' · ') || 'active'));
    }
    return el;
  };

  return h('div.it-col', null,
    h('div.it-sec-head', null, h('div.it-sec-titles', null,
      h('div.it-sec-t', null, 'Their social media'),
      h('div.it-sec-s', null, `Public profiles · last 90 days${checked ? ` · checked ${fmtDate(checked)}` : ''}`))),
    rows.length
      ? h('div.it-sg', null,
          h('div.it-sg-head', null, h('div.it-sg-ch.section-label', null, 'CHANNEL'), comps.map((c) => h('div.it-sg-c', null, c.name))),
          rows.map((ch) => h('div.it-sg-row', null,
            h('div.it-sg-ch', null, ch.label),
            comps.map((c) => cell(store.social.find((s) => s.channel === ch.id && s.competitorId === c.id), ch.label)))))
      : h('div.it-empty', null, h('div.it-empty-t', null, 'No social profiles checked yet'), h('div.it-empty-s', null, 'Tick Marketing & social on a competitor and scout reads their public profiles.')),
    complaints.length ? h('div.it-block', null,
      h('div.it-block-head', null, h('div.section-label.flex1.bad', null, `COMPLAINTS IN THEIR COMMENTS${commentCount ? ` · ${commentCount}` : ''}`)),
      complaints.map((c) => {
        const comp = store.competitors.find((x) => x.id === c.competitorId);
        const src = c.sources[0];
        const el = h('button.it-cc', { title: 'Show sources' },
          h('span.it-cc-dot', { style: { background: companyColour(comp) } }),
          h('div.flex1', null,
            h('div.it-cc-t', null, c.text),
            h('div.it-cc-s', null, labelDot(c.label), [src?.title, c.metric, fmtDate(src?.publishedAt ?? src?.seenAt, true)].filter(Boolean).join(' · '))));
        el.onclick = () => openSources(el, 'Comment', c.sources, c);
        return el;
      })) : null,
    engagement.length ? h('div.it-block', null,
      h('div.section-label', null, 'WHAT GETS ENGAGEMENT'),
      h('div.it-eng', null, engagement.map((e) => {
        const el = h('button.it-eng-c', null, h('div.it-eng-t', null, e.text), h('div.it-eng-s', null, labelDot(e.label), [e.competitorId ? companyName(store, e.competitorId) : null, e.metric].filter(Boolean).join(' ')));
        el.onclick = () => openSources(el, e.text, e.sources, e);
        return el;
      }))) : null,
    wins.length ? h('div.it-win', null,
      h('div.it-win-k', null, 'WHERE WE CAN WIN ON SOCIAL'),
      wins.map((w) => {
        const el = h('button.it-win-r', null, h('span.it-win-up', null, '↑'), h('span.flex1', null, w.text), labelDot(w.label));
        el.onclick = () => openSources(el, w.text, w.sources, w);
        return el;
      }),
      h('div.it-win-cap', null, 'Followers and likes show attention, not sales or growth.')) : null,
    !wins.length && (rows.length || engagement.length) ? caption('Followers and likes show attention, not sales or growth.') : null);
}
