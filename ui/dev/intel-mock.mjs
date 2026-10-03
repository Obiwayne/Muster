// Mock competitive intelligence for ui/dev/mock-server.mjs: an IntelStore for wall-education vs Padlet, Wakelet
// and Linoit (the Vellum designs' sample data), the /api/intel/* routes, GET /api/browser and the `intel` event.
//
//   MOCK_INTEL=none     → no competitors yet (empty Intel page)
//   MOCK_INTEL=running  → a sweep is running
//   MOCK_BROWSER=off    → GET /api/browser says playwright-core is missing
//
// Package D adds: intel checks on the ideas (R7 edge at risk, R9 edge, R10 gap, R8 approved, R12 stale, R13 open;
// R11/R14… none), full opportunity fields on the intel ideas, POST /api/intel/ask with an ideaId, the approve gate
// (gate()), check jobs that fill a check, and the human browser writes (login, close, opera-import, forget).

/**
 * @param {{ state: any, config: any, now: number, need: Function, HttpError: any, send: (msg: object) => void, toastAll: Function, readBody: (req: any) => Promise<any> }} deps
 */
export function createIntelMock(deps) {
  const { state, config, now, need, send, toastAll } = deps;
  const broadcastState = () => deps.broadcast?.();
  const MODE = process.env.MOCK_INTEL ?? 'done';
  const ymd = (daysAgo) => new Date(now - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const today = ymd(0);

  config.researchBrowser ??= { mode: 'profile', channel: 'chrome', operaAllow: [], minDelayMs: 3000, maxPagesPerJob: 150 };
  config.intel ??= { recheck: 'weekly', checkMaxAgeDays: 14 };

  // ---------------------------------------------------------------- sources
  const src = (kind, title, url, publishedAgo, extra = {}) => ({ kind, title, ...(url ? { url } : {}), ...(publishedAgo !== undefined ? { publishedAt: ymd(publishedAgo) } : {}), seenAt: ymd(1), ...extra });
  const S = {
    padletPricing: src('pricing', 'Padlet pricing page', 'https://padlet.com/premium/plans'),
    padletHelp: src('help', 'Padlet help centre: moderation', 'https://padlet.help/l/en/article/moderation'),
    wakeletRoadmap: src('roadmap', 'Wakelet public roadmap', 'https://wakelet.com/roadmap'),
    wakeletHelp: src('help', 'Wakelet help: Google Classroom', 'https://learn.wakelet.com/google-classroom'),
    linoitSite: src('site', 'Linoit features page', 'https://en.linoit.com/en_US/features'),
    trial: src('own_app', 'Hands-on trial of each app', undefined),
    ownApp: src('own_app', 'wall-education roadmap and code', undefined),
    asPadlet: src('app_store', 'App Store · Padlet · 2★', 'https://apps.apple.com/us/app/padlet/id834618886?see-all=reviews', 19),
    rTeachers: src('reddit', 'r/Teachers · 412 upvotes', 'https://www.reddit.com/r/Teachers/comments/1fq2x/approve_posts_first/', 31, { via: 'profile' }),
    g2Padlet: src('g2', 'G2 · Padlet · 2★', 'https://www.g2.com/products/padlet/reviews', 44),
    playWakelet: src('google_play', 'Google Play · Wakelet · 3★', 'https://play.google.com/store/apps/details?id=com.wakelet.app', 12),
    rEdtech: src('reddit', 'r/edtech · 88 upvotes', 'https://www.reddit.com/r/edtech/comments/1fz0p/', 20, { via: 'profile' }),
    tiktokPadlet: src('tiktok', 'TikTok · Padlet', 'https://www.tiktok.com/@padlet', 5),
    ytWakelet: src('youtube', 'YouTube · Wakelet', 'https://www.youtube.com/@Wakelet', 14),
    linkedinPadlet: src('linkedin', 'LinkedIn · Padlet jobs', 'https://www.linkedin.com/company/padlet/jobs/', 9, { via: 'profile' }),
    chLinoit: src('companies_house', 'Companies House · filing history', 'https://find-and-update.company-information.service.gov.uk/company/09876543/filing-history', 15),
    chWakelet: src('companies_house', 'Companies House · Wakelet Limited', 'https://find-and-update.company-information.service.gov.uk/company/10234567', 30),
    padletBlog: src('press', 'Padlet blog: "AI recipes"', 'https://padlet.blog/ai-recipes', 60),
  };
  const claim = (label, confidence, sources, asOfAgo = 1, extra = {}) => ({ label, confidence, sources, asOf: ymd(asOfAgo), ...extra });
  const cell = (status, sources, extra = {}) => ({ ...claim('fact', 'high', sources), status, ...extra });

  // ---------------------------------------------------------------- store
  const store = {
    version: 1, rev: 1, competitors: [], capabilities: [], themes: [], social: [], socialInsights: [], plans: [], findings: [], scenarios: [],
    filings: [], insights: [], changes: [], checks: [], watches: [], jobs: [], captainThread: [],
    nextIds: { capability: 1, theme: 1, insight: 1, plan: 1, finding: 1, scenario: 1, social: 1, change: 1, check: 1, watch: 1, job: 1 },
  };
  const us = { id: 'us', name: config.projectName || 'wall-education', url: '', isUs: true, colour: 0, sources: [], areas: [], watch: 'off', browse: 'profile', addedAt: iso(60 * 24 * 30) };
  if (us.name === 'acme-app') us.name = 'wall-education';
  store.competitors.push(us);

  if (MODE !== 'none') seedFull();

  function seedFull() {
    const comp = (id, name, url, colour, tagline, sources, identity) => ({
      id, name, url, colour, tagline, sources, identity, areas: ['features', 'roadmap', 'reviews', 'gaps', 'audience', 'pricing', 'ai', 'financials', 'team'],
      watch: 'weekly', browse: 'profile', addedAt: iso(60 * 24 * 12), lastSweptAt: iso(6 * 60),
    });
    store.competitors.push(
      comp('padlet', 'Padlet', 'https://padlet.com', 0, 'Visual collaboration for schools',
        [{ kind: 'pricing', url: 'https://padlet.com/premium/plans', label: 'Pricing page' }, { kind: 'app_store', url: 'https://apps.apple.com/us/app/padlet/id834618886', note: '4.6★ · 41k' }, { kind: 'tiktok', url: 'https://www.tiktok.com/@padlet' }],
        { legalName: 'Wallwisher, Inc.', matchedFrom: 'terms of service' }),
      comp('wakelet', 'Wakelet', 'https://wakelet.com', 1, 'Save, organise and share content',
        [{ kind: 'roadmap', url: 'https://wakelet.com/roadmap', label: 'Public roadmap', note: 'Canny' }, { kind: 'google_play', url: 'https://play.google.com/store/apps/details?id=com.wakelet.app', note: '3.8★ · 900' }],
        { legalName: 'Wakelet Limited', matchedFrom: 'site footer', companiesHouse: { number: '10234567', status: 'Active', incorporated: '2016-06-14', registeredOffice: 'Hoults Yard, Newcastle upon Tyne, NE6 2HL', url: 'https://find-and-update.company-information.service.gov.uk/company/10234567' } }),
      comp('linoit', 'Linoit', 'https://linoit.com', 2, 'Sticky notes on a canvas',
        [{ kind: 'site', url: 'https://en.linoit.com/', label: 'Website' }],
        { legalName: 'Lino Boards Ltd', matchedFrom: 'privacy policy', companiesHouse: { number: '09876543', status: 'Active', incorporated: '2015-10-02', registeredOffice: '20 Wenlock Road, London, N1 7GU', url: 'https://find-and-update.company-information.service.gov.uk/company/09876543' } }),
    );

    const cap = (id, name, group, cells, verdict, verdictVs, extra = {}) => ({ id, name, group, cells, verdict, verdictVs, updatedAt: iso(60 * 20), ...extra });
    store.capabilities.push(
      cap('F1', 'Approve posts before live', 'Moderation', {
        us: cell('planned', [S.ownApp], { stageId: 'M3' }), padlet: cell('partial', [S.padletHelp], { note: undefined }),
        wakelet: cell('none', [S.trial]), linoit: cell('none', [S.linoitSite]),
      }, 'edge', ['padlet', 'wakelet', 'linoit'], { verdictStage: 'M3', ideaId: 'R7' }),
      cap('F2', 'Google Classroom roster sync', 'Classes', {
        us: cell('missing', [S.ownApp]), padlet: cell('yes', [S.padletHelp]), wakelet: cell('yes', [S.wakeletHelp]), linoit: cell('none', [S.linoitSite]),
      }, 'gap', ['padlet', 'wakelet'], { ideaId: 'R10' }),
      cap('F3', 'Export a wall as PDF', 'Sharing', {
        us: cell('planned', [S.ownApp], { stageId: 'M5' }), padlet: cell('paid', [S.padletPricing]), wakelet: cell('yes', [S.trial]), linoit: cell('partial', [S.linoitSite]),
      }, 'gap', ['padlet', 'wakelet'], { verdictStage: 'M5', goalId: 'G14', ideaId: 'R8' }),
      cap('F4', 'Unlimited walls on free plan', 'Pricing', {
        us: cell('yes', [S.ownApp]), padlet: cell('paid', [S.padletPricing], { note: '3 walls' }), wakelet: cell('yes', [S.trial]), linoit: cell('yes', [S.linoitSite]),
      }, 'edge', ['padlet']),
      cap('F5', 'AI-generated wall content', 'AI', {
        us: cell('missing', [S.ownApp]), padlet: cell('paid', [S.padletBlog], { note: 'Credits' }), wakelet: cell('partial', [S.trial]), linoit: cell('none', [S.linoitSite]),
      }, 'gap', ['padlet'], { ideaId: 'R12' }),
      cap('F6', 'AI flags unsafe posts', 'Moderation', {
        us: cell('none', [S.ownApp]), padlet: cell('none', [S.padletHelp]), wakelet: cell('none', [S.trial]), linoit: cell('none', [S.linoitSite]),
      }, 'open', [], { ideaId: 'R13' }),
      cap('F7', 'Works well on a phone', 'Basics', {
        us: cell('yes', [S.ownApp]), padlet: cell('partial', [S.asPadlet]), wakelet: cell('yes', [S.trial]), linoit: cell('none', [S.trial]),
      }, 'edge', ['padlet', 'linoit']),
      cap('F8', 'Live updates while the class posts', 'Basics', {
        us: cell('yes', [S.ownApp]), padlet: cell('yes', [S.trial]), wakelet: cell('yes', [S.trial]), linoit: cell('yes', [S.trial]),
      }, 'parity', []),
      cap('F9', 'Embed videos and links', 'Basics', {
        us: cell('yes', [S.ownApp]), padlet: cell('yes', [S.trial]), wakelet: cell('yes', [S.trial]), linoit: cell('partial', [S.linoitSite]),
      }, 'edge', ['linoit']),
    );

    const theme = (id, title, mentions, indep, by, severity, trend, extra = {}) => ({
      ...claim('opinion', indep >= 10 ? 'high' : 'medium', [S.asPadlet, S.rTeachers, S.g2Padlet, S.playWakelet]),
      id, title, mentions, sampleSize: 475, independentSources: indep, byCompetitor: by, severity, trend, quotes: [], ...extra,
    });
    store.sample = {
      window: 'last 12 months', total: 475, asOf: ymd(0),
      counts: [
        { kind: 'app_store', label: 'App Store', n: 188 }, { kind: 'google_play', label: 'Google Play', n: 121 }, { kind: 'g2', label: 'G2 · Capterra', n: 103 },
        { kind: 'reddit', label: 'Reddit · forums', n: 63 }, { kind: 'social_comments', label: 'Social comments', n: 94 },
      ],
    };
    store.themes.push(
      theme('TH1', 'No control over what students post', 104, 61, { padlet: 72, wakelet: 18, linoit: 14 }, 'severe', 'rising', {
        trendNote: 'rising since Jun', who: 'Primary teachers', workaround: 'Lock wall, delete fast',
        quotes: [
          { text: 'A student posted something awful and the whole class saw it before I could delete it.', source: S.asPadlet },
          { text: 'Is there any wall tool where I approve posts first? Stopped using it because of this.', source: S.rTeachers },
        ],
        ourAnswer: { kind: 'edge', text: 'Our edge: approve-before-publish, on M3', ideaId: 'R7' },
        implication: 'Teachers leave over this; our M3 moderation queue answers it directly.',
      }),
      theme('TH2', 'Free plan limits and paywall', 81, 44, { padlet: 68, wakelet: 5, linoit: 8 }, 'high', 'rising', { ourAnswer: { kind: 'edge', text: 'Unlimited free walls' } }),
      theme('TH3', 'Confusing sharing settings', 62, 30, { padlet: 27, wakelet: 25, linoit: 10 }, 'high', 'steady', { ourAnswer: { kind: 'opportunity', text: 'One-screen share dialog', ideaId: 'R14' } }),
      theme('TH4', 'Clunky on phones and tablets', 52, 27, { padlet: 21, wakelet: 8, linoit: 23 }, 'medium', 'easing', { ourAnswer: { kind: 'edge', text: 'Mobile-first wall' } }),
      theme('TH5', 'Slow or no support replies', 33, 19, { padlet: 13, wakelet: 12, linoit: 8 }, 'medium', 'steady', { ourAnswer: { kind: 'watch', text: 'Keep our replies under a day' } }),
      theme('TH6', 'Why they switch away: “price went up”, “kids saw bad posts”', 38, 22, { padlet: 30, wakelet: 6, linoit: 2 }, 'high', 'rising', { ourAnswer: { kind: 'win_over', text: 'Switch guide + import' } }),
      theme('TH7', '“So easy to start” · templates · works with Google', 147, 80, { padlet: 90, wakelet: 57 }, 'low', 'steady', { love: true, implication: 'Customers will expect this from us too.' }),
      theme('TH8', 'Exports lose formatting', 6, 3, { padlet: 4, wakelet: 2 }, 'low', 'new'),
    );

    const ch = (competitorId, channel, presence, followers, cadence, contentType, extra = {}) => ({
      ...claim('fact', 'high', [S.tiktokPadlet]), competitorId, channel, presence, followers, cadence, contentType, ...extra,
    });
    store.social.push(
      ch('padlet', 'youtube', 'active', 96000, '2 / wk', 'tutorials'), ch('wakelet', 'youtube', 'active', 31000, '1 / wk', 'webinars'), ch('linoit', 'youtube', 'dormant', 2000, undefined, undefined, { dormantFor: '14 mo' }),
      ch('padlet', 'tiktok', 'active', 210000, '5 / wk', 'hacks'), ch('wakelet', 'tiktok', 'absent'), ch('linoit', 'tiktok', 'absent'),
      ch('padlet', 'instagram', 'active', 74000, '3 / wk'), ch('wakelet', 'instagram', 'active', 18000, '2 / wk'), ch('linoit', 'instagram', 'absent'),
      ch('padlet', 'linkedin', 'active', 41000, undefined, 'district sales'), ch('wakelet', 'linkedin', 'active', 12000, undefined, 'hiring posts'), ch('linoit', 'linkedin', 'active', 400, 'rarely'),
      ch('padlet', 'reddit', 'absent', undefined, undefined, undefined, { replies: 'No replies · 41 unanswered' }),
      ch('wakelet', 'reddit', 'active', undefined, undefined, undefined, { replies: 'Staff reply · ~2 days' }), ch('linoit', 'reddit', 'absent'),
    );
    const so = (id, kind, text, competitorId, metric, sources, label = 'opinion') => ({ ...claim(label, 'medium', sources), id, kind, text, competitorId, metric });
    store.socialInsights.push(
      so('SO1', 'comment_complaint', '“Love this hack but why is PDF export paid now??”', 'padlet', '1.2k likes · reply from Padlet: none', [S.tiktokPadlet]),
      so('SO2', 'comment_complaint', '“Students keep getting kicked off on iPads during the webinar demo.”', 'wakelet', '86 likes', [S.ytWakelet]),
      so('SO3', 'engagement', '30-sec “one wall, whole lesson” hacks', 'padlet', 'TikTok · 8× avg views', [S.tiktokPadlet], 'fact'),
      so('SO4', 'engagement', 'Teacher-led walkthroughs', 'wakelet', 'YouTube · 3× avg views', [S.ytWakelet], 'fact'),
      so('SO5', 'win', 'Answer the 41 unanswered Reddit questions Padlet ignores.', 'padlet', undefined, [S.rTeachers], 'prediction'),
      so('SO6', 'win', 'Only Padlet is on TikTok. Short “safe wall in 30 sec” clips are open ground.', undefined, undefined, [S.tiktokPadlet], 'prediction'),
    );
    store.socialInsights.filter((s) => s.label === 'prediction').forEach((s) => { s.prediction = { signals: ['41 unanswered threads in 90 days', 'No staff accounts on r/Teachers'], timeframe: 'next 3 months', wouldChange: 'Padlet starts replying on Reddit' }; });

    store.plans.push(
      { ...claim('fact', 'high', [S.wakeletRoadmap], 4), id: 'PL1', competitorId: 'wakelet', title: 'Post approval', kind: 'commitment', status: 'in_progress', timeframe: 'Q4 2026', capabilityIds: ['F1'], implication: 'Our moderation edge has a deadline: ship M3 before Wakelet does.' },
      { ...claim('fact', 'high', [S.wakeletRoadmap], 4), id: 'PL2', competitorId: 'wakelet', title: 'Google Classroom roster sync v2', kind: 'commitment', status: 'planned', timeframe: 'Q1 2027', capabilityIds: ['F2'] },
      { ...claim('prediction', 'low', [S.linkedinPadlet, S.padletBlog], 9), id: 'PL3', competitorId: 'padlet', title: 'AI summary of a whole wall for parents', kind: 'prediction', timeframe: 'Q1 2027', capabilityIds: ['F5'],
        prediction: { signals: ['Hiring 3 ML engineers', '"AI recipes" launch post', 'Parent view on their roadmap survey'], timeframe: 'Q1 2027', wouldChange: 'No AI items in the next two changelogs' },
        implication: 'Test parent summaries with 5 teachers before building.' },
    );

    const fi = (id, competitorId, area, title, label, confidence, sources, extra = {}) => ({ ...claim(label, confidence, sources, 2), id, competitorId, area, title, ...extra });
    store.findings.push(
      fi('IF1', 'padlet', 'audience', 'Sells to districts, markets to teachers', 'fact', 'medium', [S.linkedinPadlet, S.padletPricing], { facts: { Claimed: 'Teachers', Evidenced: 'District buyers (US)' }, detail: 'Pricing and LinkedIn posts target district licences; the site talks to teachers.' }),
      fi('IF2', 'wakelet', 'audience', 'UK secondary schools and libraries', 'fact', 'medium', [S.wakeletHelp], { facts: { Claimed: 'Educators everywhere', Evidenced: 'UK secondary, librarians' } }),
      fi('IF3', undefined, 'audience', 'UK primary schools on tight budgets are underserved', 'prediction', 'medium', [S.padletPricing, S.rTeachers], { prediction: { signals: ['No UK pricing page from Padlet', 'r/Teachers UK threads ask for free options'], timeframe: 'now', wouldChange: 'Padlet launches GBP school pricing' } }),
      fi('IF4', 'padlet', 'pricing', 'Padlet tiers', 'fact', 'high', [S.padletPricing], { facts: { Free: '3 walls', Pro: '£8/mo', 'Padlet for Schools': 'quote, ~£2k/yr for 30 teachers' } }),
      fi('IF5', 'wakelet', 'pricing', 'Wakelet is free for educators', 'fact', 'high', [S.trial], { facts: { Free: 'unlimited', Paid: 'none for schools' }, detail: 'Funded by enterprise and partnerships.' }),
      fi('IF6', 'padlet', 'marketing', 'TikTok hacks drive their top of funnel', 'fact', 'medium', [S.tiktokPadlet], { detail: '5 posts a week, 8× average views on 30-second lesson hacks.' }),
      fi('IF7', 'padlet', 'team', 'Hiring 3 ML engineers', 'fact', 'high', [S.linkedinPadlet], { partial: true, detail: 'Three open ML roles on LinkedIn; no AI lead listed publicly.' }),
      fi('IF8', 'wakelet', 'team', '~45 staff, product team in Newcastle', 'fact', 'low', [S.linkedinPadlet], { partial: true }),
      fi('IF9', 'padlet', 'ai', '"AI recipes" generate wall content', 'fact', 'high', [S.padletBlog, S.trial], { aiStatus: 'verified', detail: 'Worked in our trial; uses credits on paid plans.' }),
      fi('IF10', 'wakelet', 'ai', '"AI-powered organisation"', 'fact', 'medium', [S.wakeletHelp], { aiStatus: 'claimed', detail: 'Marketing claim; nothing visible in the trial.' }),
    );
    store.scenarios.push({
      ...claim('fact', 'medium', [S.padletPricing], 2), id: 'PS1', name: '30-teacher primary school for a year',
      assumptions: ['30 teacher accounts, students free', 'Public list prices, no discounts', 'GBP, VAT excluded', 'Padlet for Schools quote from their pricing form'],
      costs: { us: { amount: 0, currency: 'GBP', period: 'year', note: 'free plan' }, padlet: { amount: 2000, currency: 'GBP', period: 'year', note: 'quote' }, wakelet: { amount: 0, currency: 'GBP', period: 'year' }, linoit: { amount: 360, currency: 'GBP', period: 'year', note: '£1/teacher/mo' } },
      implication: 'Price is not where we win; safety and the free tier are.',
    });
    store.filings.push(
      { ...claim('fact', 'high', [S.chWakelet], 30), competitorId: 'wakelet', companyNumber: '10234567', status: 'Active', incorporated: '2016-06-14', accountsType: 'small', accountsMadeUpTo: '2025-12-31', accountsDue: '2026-09-30', officers: 4, pscs: ['Jamie Smith'], figures: { 'Net assets': '£1.2m', Employees: '45' }, limits: 'Small-company accounts: no turnover or profit figures.' },
      { ...claim('fact', 'high', [S.chLinoit], 15), competitorId: 'linoit', companyNumber: '09876543', status: 'Active', incorporated: '2015-10-02', accountsType: 'micro-entity', accountsMadeUpTo: '2024-10-31', accountsDue: '2026-07-31', overdue: true, officers: 1, pscs: ['Lino Holdings KK'], limits: 'Micro-entity accounts show almost nothing; overdue filing is a weak signal, not proof of trouble.' },
    );
    store.positioning = {
      ...claim('prediction', 'medium', [S.padletPricing, S.trial], 2),
      prediction: { signals: ['7 moderation features compared', 'Public price lists'], timeframe: 'today', wouldChange: 'A competitor ships approval or changes school pricing' },
      title: 'Price for a 30-teacher school vs. classroom safety',
      x: { label: 'Price for a 30-teacher school', min: '£0', max: '£2k+/yr' },
      y: { label: 'Classroom safety', min: 'Open', max: 'Safe' },
      points: [
        { competitorId: 'padlet', x: 0.82, y: 0.62 }, { competitorId: 'wakelet', x: 0.28, y: 0.3 }, { competitorId: 'linoit', x: 0.16, y: 0.13 },
        { competitorId: 'us', x: 0.22, y: 0.45, label: 'us today' }, { competitorId: 'us', x: 0.22, y: 0.8, future: true, label: 'us after M3' },
      ],
      openSpace: { x0: 0, y0: 0.55, x1: 0.48, y1: 1, label: 'OPEN SPACE' },
      assumptions: ["Safety score is scout's judgement from 7 moderation features — not a measured fact.", `Prices from public pricing pages, ${new Date(now - 86_400_000).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}.`],
    };
    const ins = (id, kind, title, detail, label, confidence, sources, extra = {}) => ({ ...claim(label, confidence, sources), id, kind, title, detail, implication: detail, ...extra });
    store.insights.push(
      ins('IN1', 'match', 'Google Classroom sync and PDF export', 'All 3 ship it', 'fact', 'high', [S.wakeletHelp, S.padletHelp, S.trial]),
      ins('IN2', 'advantage', 'Approve-before-publish moderation', '#1 complaint, 38 reviews', 'opinion', 'high', [S.asPadlet, S.rTeachers], { ideaId: 'R7' }),
      ins('IN3', 'audience', 'UK primary schools on tight budgets', 'No UK pricing page', 'fact', 'medium', [S.padletPricing]),
      ins('IN4', 'test', 'AI summary of a whole wall for parents', 'Padlet likely ships in Q1', 'prediction', 'low', [S.linkedinPadlet], { ideaId: 'R12', prediction: { signals: ['Hiring 3 ML engineers'], timeframe: 'Q1 2027', wouldChange: 'No AI items in their next changelogs' } }),
    );
    const chg = (id, daysAgo, competitorId, area, title, implication, planImpact, label, confidence, sources, extra = {}) => ({
      ...claim(label, confidence, sources, daysAgo), id, at: ymd(daysAgo), competitorId, area, title, implication, planImpact, seen: true, ...extra,
    });
    store.changes.push(
      chg('IX1', 1, 'padlet', 'pricing', 'Padlet raised Pro to £8/mo', 'Widens our price gap for schools. No roadmap change.', 'none', 'fact', 'high', [S.padletPricing], { seen: false }),
      chg('IX2', 4, 'wakelet', 'roadmap', 'Wakelet roadmap: “Post approval” → in progress', 'Threatens our advantage.', 'respond', 'fact', 'high', [S.wakeletRoadmap], { seen: false, suggestion: 'Captain suggests keeping M3 on Oct 20.', ideaId: 'R7' }),
      chg('IX3', 9, 'padlet', 'team', 'Padlet hiring 3 ML engineers', 'Signals more AI features. Prediction, low confidence.', 'watch', 'prediction', 'low', [S.linkedinPadlet], { prediction: { signals: ['3 ML job posts'], timeframe: 'Q1 2027', wouldChange: 'Roles closed unfilled' } }),
      chg('IX4', 15, 'linoit', 'financials', 'Linoit filed late accounts', 'Companies House shows overdue filing. Watch only.', 'watch', 'fact', 'high', [S.chLinoit]),
      chg('IX5', 22, 'wakelet', 'features', 'Wakelet shipped Immersive Reader in collections', 'Accessibility parity matters to UK schools. Note for M4.', 'watch', 'fact', 'high', [S.wakeletHelp]),
      chg('IX6', 30, 'padlet', 'ai', 'Padlet launched “AI recipes”', 'AI content is now a paid Padlet feature; test before we build.', 'respond', 'fact', 'high', [S.padletBlog], { seen: false, ideaId: 'R12', suggestion: 'Captain: keep R12 as a test, not a goal.' }),
    );
    store.watches.push(
      { id: 'W1', subject: { kind: 'competitor', competitorId: 'padlet' }, cadence: 'weekly', nextAt: iso(-60 * 24 * 6), lastAt: iso(6 * 60), active: true },
      { id: 'W2', subject: { kind: 'competitor', competitorId: 'wakelet' }, cadence: 'weekly', nextAt: iso(-60 * 24 * 6), lastAt: iso(6 * 60), active: true },
      { id: 'W3', subject: { kind: 'competitor', competitorId: 'linoit' }, cadence: 'weekly', nextAt: iso(-60 * 24 * 6), lastAt: iso(6 * 60), active: true },
    );
    store.jobs.push({ id: 'IJ1', kind: 'sweep', status: 'done', competitorIds: ['padlet', 'wakelet', 'linoit'], areas: ['features', 'roadmap', 'reviews', 'gaps', 'audience', 'pricing', 'ai', 'financials', 'team'], browse: 'profile', depth: 'thorough', by: 'you', queuedAt: iso(7 * 60), startedAt: iso(7 * 60), finishedAt: iso(6 * 60), summary: '214 sources across 3 competitors', sourcesRead: 214, pagesBrowsed: 96 });
    if (MODE === 'running') store.jobs.push({ id: 'IJ2', kind: 'sweep', status: 'running', competitorIds: ['padlet', 'wakelet', 'linoit'], areas: ['features', 'reviews', 'pricing'], browse: 'profile', depth: 'quick', by: 'you', queuedAt: iso(4), startedAt: iso(4), pagesBrowsed: 17 });
    store.nextIds = { capability: 10, theme: 9, insight: 5, plan: 4, finding: 11, scenario: 2, social: 7, change: 7, check: 1, watch: 4, job: MODE === 'running' ? 3 : 2 };

    // intel ideas (gaps / open spaces) next to the research ideas
    const opp = (kind, capabilityIds, valueScore, effortScore, extra = {}) => ({
      kind, capabilityIds, problem: '', alternatives: '', proposal: '', value: '', effortNote: '', priority: 'next', validation: '', valueScore, effortScore,
      claim: claim('opinion', 'medium', [S.asPadlet], 1, { implication: '' }), ...extra,
    });
    const intelIdea = (id, title, summary, impact, effort, o, extra = {}) => ({ id, runId: 'IJ1', origin: 'intel', title, summary, impact, effort, evidence: [], status: 'new', thread: [], createdAt: iso(6 * 60), opportunity: o, ...extra });
    state.research.ideas.push(
      intelIdea('R12', 'AI summary of a wall for parents', 'Padlet sells AI content on credits; parents ask what happened in class.', 'medium', 'M', opp('gap', ['F5'], 3, 3, {
        testFirst: true, priority: 'later',
        problem: "Parents can't see what happened in class; teachers write the weekly summary by hand.",
        alternatives: 'A weekly email typed from the wall, or nothing.',
        proposal: 'One-click "summary for parents" of a wall, reviewed by the teacher before it is sent.',
        value: 'Saves 20–30 min a week for teachers who write parent updates.',
        effortNote: 'Medium · ~5 tasks · needs an AI provider decision',
        validation: 'Fake-door button on 3 schools\' walls; build if 1 in 5 teachers click it in two weeks.',
        claim: claim('prediction', 'low', [S.padletBlog, S.linkedinPadlet], 9, { implication: 'Worth a test, not a goal, until parents ask for it.', prediction: { signals: ['Padlet "AI recipes" launch', 'Hiring 3 ML engineers'], timeframe: 'Q1 2027', wouldChange: 'Parents ask for it in reviews' } }),
      })),
      intelIdea('R13', 'AI flags unsafe posts before a teacher sees them', 'Nobody does it; pairs with the moderation queue.', 'high', 'L', opp('open', ['F6'], 4, 4, {
        problem: 'A teacher with 30 students can\'t read every post live; unsafe posts slip through before review.',
        alternatives: 'Turn posting off, or review every post by hand.',
        proposal: 'Flag likely-unsafe posts in the moderation queue and hold them automatically.',
        value: 'Safety parents and schools can see; nobody else offers it.',
        effortNote: 'Large · ~8 tasks · needs the M3 moderation queue first',
        validation: 'Run the classifier over 2,000 public test posts; ship if it catches 9 in 10 with few false alarms.',
        claim: claim('opinion', 'medium', [S.rTeachers, S.asPadlet], 2, { implication: 'Be first: it builds on the moderation edge.' }),
      })),
      intelIdea('R14', 'One-screen share dialog', '13% of reviews call sharing settings confusing.', 'medium', 'S', opp('gap', [], 4, 2, {
        priority: 'now',
        problem: "Teachers can't tell who can see or post on a wall; 62 reviews call sharing settings confusing.",
        alternatives: 'Share the link and hope, or lock the wall and reopen it by hand.',
        proposal: 'One share screen: who can see, who can post, approve first, with a plain-language summary.',
        value: 'Fewer accidental public walls and fewer "students can\'t post" emails.',
        effortNote: 'Small · ~3 tasks · needs the M3 share dialog from crew-3',
        validation: 'Watch 5 teachers set up a wall; ship if all get sharing right first time.',
        claim: claim('opinion', 'high', [S.asPadlet, S.g2Padlet, S.playWakelet], 2, { implication: 'Padlet and Wakelet both confuse teachers here: a cheap way to win switchers.' }),
      }), {
        stageId: 'M3',
        evidence: [{ kind: 'review', source: 'App Store review · Padlet · 2★', text: 'I never know if my wall is public or not.', count: 37 }, { kind: 'forum', source: 'r/edtech · 88 upvotes', url: 'https://www.reddit.com/r/edtech/', count: 2 }],
        thread: [
          { at: iso(50), from: 'you', text: 'Can we get the share screen in before launch?' },
          { at: iso(44), from: 'captain', text: "Yes, if it goes in M3 next to sharing: it reuses the dialog crew-3 is building. About 3 tasks.\n\nM3 slips 1 day. Launch stays Nov 14." },
          { at: iso(20), from: 'you', text: 'Good. Start the copy review today if it\'s cheap.' },
          { at: iso(16), from: 'captain', text: "It's one task for crew-3 and fits inside the existing sharing goal. Here's the change:" },
        ],
        plan: ['+ Add goal One-screen share dialog to M3 (3 tasks)', 'Start "share copy review" today (crew-3)', '~ Move M3 due date (Oct 20 → 21)', 'Launch stays Nov 14 · evidence linked to each goal'],
      }),
      intelIdea('R15', 'Offline phone editor', 'Wakelet and Padlet both edit offline on phones; ours needs a connection.', 'medium', 'L', opp('gap', [], 3, 4, {
        problem: 'Teachers on school Wi-Fi lose posts when the connection drops.', proposal: 'Queue edits on the phone and sync when back online.', value: 'Fewer lost posts on bad school Wi-Fi.',
        effortNote: 'Large · ~7 tasks', validation: 'Count failed saves in our logs first.', claim: claim('opinion', 'medium', [S.playWakelet], 3, { implication: 'Real but not urgent.' }),
      })),
      intelIdea('R16', 'School-wide admin billing', 'Padlet sells to districts with one invoice; we bill per teacher.', 'business', 'L', opp('gap', [], 3, 5, {
        priority: 'parked', problem: 'Schools want one invoice for every teacher.', proposal: 'An admin seat that pays for the school.', value: 'Bigger deals later.',
        effortNote: 'Large · billing rework', validation: 'Ask the 3 pilot schools first.', claim: claim('fact', 'high', [S.padletPricing], 3, { implication: 'Later: after launch.' }),
      })),
      intelIdea('R17', 'UK school pricing in £', 'Everyone prices in $; UK schools pay by invoice in £.', 'business', 'S', opp('open', [], 3, 2, {
        problem: 'UK schools need £ prices and invoices to buy.', proposal: '£ price list and invoice billing.', value: 'Easier sign-off for UK schools.',
        effortNote: 'Small · pricing page and invoice template', validation: 'Ask 5 UK teachers what their bursar needs.', claim: claim('fact', 'medium', [S.padletPricing], 3, { implication: 'Nobody does it; cheap to try.' }),
      })),
    );

    // intel checks on the ideas (Roadmap → Research chips and the shared Intel check panel)
    const row = (area, finding, signal, label, confidence, sources, extra = {}) => ({ ...claim(label, confidence, sources), area, finding, signal, ...extra });
    const pred = (timeframe) => ({ prediction: { signals: ['On their public roadmap', 'Two job posts mention it'], timeframe, wouldChange: 'It leaves their roadmap' } });
    const check = (id, ideaId, verdict, verdictText, confidence, sourceCount, capabilityIds, rows, doneDaysAgo, extra = {}) => ({
      id, ideaId, revision: 1, status: 'done', rows, verdict, verdictText, confidence, sourceCount, capabilityIds,
      createdAt: iso(doneDaysAgo * 1440 + 40), doneAt: iso(doneDaysAgo * 1440), history: [], ...extra,
    });
    store.checks.push(
      check('IC1', 'R7', 'edge_at_risk', 'build before Wakelet ships, or lose the edge.', 'high', 214, ['F1'], [
        row('features', 'Padlet partial · Linoit none', 'supports', 'fact', 'high', [S.padletHelp, S.linoitSite]),
        row('complaints', '#1 theme · 22% · rising', 'supports', 'opinion', 'high', [S.asPadlet, S.g2Padlet]),
        row('social', 'r/Teachers 412 ↑ · 9 TikTok comments', 'supports', 'opinion', 'medium', [S.rTeachers, S.tiktokPadlet]),
        row('plans', 'Wakelet building it · likely Q1', 'threat', 'prediction', 'medium', [S.wakeletRoadmap], pred('Q1 2027')),
        row('pricing', 'Free for us · Padlet: Pro only', 'supports', 'fact', 'high', [S.padletPricing]),
        row('audience', 'Primary teachers · UK schools', 'neutral', 'fact', 'medium', [S.rTeachers]),
        row('ai', 'None of them auto-flag posts yet', 'neutral', 'fact', 'medium', [S.trial]),
      ], 0, { watchFor: 'Wakelet ships post approval', revision: 2, history: [{ revision: 1, verdict: 'edge', confidence: 'high', doneAt: iso(8 * 1440), changedAreas: ['plans'] }] }),
      check('IC2', 'R9', 'edge', 'keep it free: it is why teachers switch from Padlet.', 'high', 61, ['F4'], [
        row('features', 'Padlet: 3 free walls · others unlimited', 'supports', 'fact', 'high', [S.padletPricing]),
        row('complaints', 'Most upvoted Padlet complaint this year', 'supports', 'opinion', 'high', [S.rTeachers, S.g2Padlet]),
        row('social', '1.2k-like TikTok comment on the cap', 'supports', 'opinion', 'medium', [S.tiktokPadlet]),
        row('plans', 'No sign Padlet lifts the cap', 'neutral', 'prediction', 'low', [S.padletBlog], pred('next 6 months')),
        row('pricing', 'Free for us · Padlet Pro £8/mo', 'supports', 'fact', 'high', [S.padletPricing]),
        row('audience', 'Teachers with 4+ classes', 'neutral', 'opinion', 'medium', [S.rTeachers]),
      ], 2, { watchFor: 'Padlet changes its free plan' }),
      check('IC3', 'R10', 'gap', 'match it before launch: switchers expect it.', 'high', 38, ['F2'], [
        row('features', 'Padlet and Wakelet have it · Linoit none', 'against', 'fact', 'high', [S.padletHelp, S.wakeletHelp]),
        row('complaints', '12 reviews + 3 Reddit threads ask for it', 'supports', 'opinion', 'medium', [S.playWakelet, S.rEdtech]),
        row('social', 'Few posts: a quiet need', 'neutral', 'opinion', 'low', [S.rEdtech]),
        row('plans', 'Both list deeper sync as coming', 'threat', 'fact', 'medium', [S.wakeletRoadmap]),
        row('pricing', 'Free on Wakelet · Pro on Padlet', 'neutral', 'fact', 'high', [S.padletPricing]),
        row('audience', 'Secondary teachers, 5+ classes', 'supports', 'opinion', 'medium', [S.rEdtech]),
        row('ai', 'Not relevant', 'neutral', 'fact', 'low', [S.trial]),
      ], 1, { watchFor: 'Padlet or Wakelet change their Classroom sync' }),
      check('IC4', 'R8', 'gap', 'closing it in M5 as G14.', 'medium', 22, ['F3'], [
        row('features', 'Padlet paid · Wakelet free', 'against', 'fact', 'high', [S.padletPricing]),
        row('complaints', '21 reviews call paid PDF export unfair', 'supports', 'opinion', 'medium', [S.asPadlet]),
        row('pricing', 'Padlet Pro only', 'supports', 'fact', 'high', [S.padletPricing]),
      ], 3, { goalId: 'G14', watchFor: 'Padlet makes PDF export free' }),
      check('IC5', 'R12', 'gap', 'test before building: AI content is paid on Padlet.', 'low', 9, ['F5'], [
        row('features', 'Padlet credits · Wakelet partial', 'against', 'fact', 'high', [S.padletBlog]),
        row('plans', 'Padlet likely ships more AI in Q1', 'threat', 'prediction', 'low', [S.linkedinPadlet], pred('Q1 2027')),
        row('ai', 'Marketing claims, not seen working', 'neutral', 'opinion', 'low', [S.padletBlog]),
      ], 20, { watchFor: 'Padlet ships an AI parent summary' }),
      check('IC6', 'R13', 'open', 'be first: nobody flags unsafe posts.', 'medium', 17, ['F6'], [
        row('features', 'None of the three', 'supports', 'fact', 'high', [S.padletHelp, S.trial, S.linoitSite]),
        row('complaints', 'Unsafe posts are the #1 theme', 'supports', 'opinion', 'high', [S.asPadlet]),
        row('ai', 'No one claims it', 'supports', 'fact', 'medium', [S.padletBlog]),
        row('plans', 'No public plans', 'neutral', 'fact', 'medium', [S.wakeletRoadmap]),
      ], 2, { watchFor: 'a competitor announces AI moderation' }),
      check('IC7', 'R14', 'gap', 'close it in M3: cheap, and the #2 complaint about both rivals.', 'high', 46, [], [
        row('features', 'Padlet and Wakelet split it over 3 screens', 'supports', 'fact', 'high', [S.padletHelp, S.wakeletHelp]),
        row('complaints', '#3 theme · 13% · steady', 'supports', 'opinion', 'high', [S.asPadlet, S.g2Padlet]),
        row('social', '“Is my wall public?” threads monthly', 'supports', 'opinion', 'medium', [S.rEdtech]),
        row('plans', 'No public plans to fix it', 'neutral', 'fact', 'medium', [S.wakeletRoadmap]),
        row('pricing', 'Free everywhere', 'neutral', 'fact', 'high', [S.padletPricing]),
        row('audience', 'New teachers in their first week', 'supports', 'opinion', 'medium', [S.rTeachers]),
        row('ai', 'Not relevant', 'neutral', 'fact', 'low', [S.trial]),
      ], 1, { watchFor: 'Padlet redesigns its share dialog' }),
    );
    store.nextIds.check = 8;
    for (const c of store.checks) { const i = state.research.ideas.find((x) => x.id === c.ideaId); if (i) i.checkId = c.id; }
    const r8 = state.research.ideas.find((x) => x.id === 'R8');
    if (r8) { r8.watchId = 'W3'; store.watches.push({ id: 'W3', subject: { kind: 'idea', ideaId: 'R8' }, cadence: 'weekly', alertOn: 'Padlet makes PDF export free', nextAt: iso(-3 * 1440), lastAt: iso(4 * 1440), active: true }); }
  }

  // ---------------------------------------------------------------- summary + events
  function summary() {
    const live = store.competitors.filter((c) => !c.isUs && !c.removed);
    const urls = new Set();
    const add = (c) => c.sources.forEach((s) => urls.add(s.url ?? s.title));
    store.capabilities.forEach((c) => Object.values(c.cells).forEach(add));
    [store.themes, store.social, store.socialInsights, store.plans, store.findings, store.scenarios, store.filings, store.insights, store.changes].forEach((l) => l.forEach(add));
    const running = store.jobs.find((j) => j.status === 'running');
    return {
      rev: store.rev, competitors: live.length, lastSweptAt: live.map((c) => c.lastSweptAt).filter(Boolean).sort().pop(),
      sources: Math.max(urls.size, store.jobs.reduce((a, j) => a + (j.sourcesRead ?? 0), 0)),
      gaps: store.capabilities.filter((c) => c.verdict === 'gap').length, edges: store.capabilities.filter((c) => c.verdict === 'edge').length,
      open: store.capabilities.filter((c) => c.verdict === 'open').length,
      newIdeas: state.research.ideas.filter((i) => i.origin === 'intel' && i.status === 'new').length,
      alerts: store.changes.filter((c) => !c.seen && c.planImpact === 'respond').length,
      ...(running ? { runningJob: { id: running.id, kind: running.kind, label: `${running.kind} ${running.competitorIds.join(', ')}`, startedAt: running.startedAt } } : {}),
      queuedJobs: store.jobs.filter((j) => j.status === 'queued').length,
    };
  }
  let saveTimer = null;
  function saved() {
    store.rev++;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => send({ type: 'intel', rev: store.rev, summary: summary() }), 100);
  }

  /** Pretend scout works through the queue: each job runs ~6 s. */
  function dispatch() {
    if (store.jobs.some((j) => j.status === 'running')) return;
    const next = store.jobs.find((j) => j.status === 'queued');
    if (!next) return;
    next.status = 'running';
    next.startedAt = new Date().toISOString();
    saved();
    const tick = setInterval(() => { if (next.status !== 'running') { clearInterval(tick); return; } next.pagesBrowsed += 3; saved(); }, 1500);
    setTimeout(() => {
      clearInterval(tick);
      if (next.status !== 'running') return;
      next.status = 'done';
      next.finishedAt = new Date().toISOString();
      next.sourcesRead = 12 + next.pagesBrowsed;
      next.summary = 'mock: nothing new recorded';
      if (next.kind === 'check' || next.kind === 'recheck') finishCheck(next);
      for (const id of next.competitorIds) { const c = store.competitors.find((x) => x.id === id); if (c) c.lastSweptAt = next.finishedAt; }
      toastAll('info', `scout finished intel job ${next.id}`);
      saved();
      dispatch();
    }, 6000);
  }
  /** A finished check job writes a plausible check (the real one comes from scout's intel_check). */
  function finishCheck(job) {
    const c = store.checks.find((x) => x.jobId === job.id);
    if (!c) return;
    const idea = state.research.ideas.find((i) => i.id === c.ideaId);
    const s = { kind: 'site', title: 'Mock source', url: 'https://example.com/mock', seenAt: ymd(0) };
    const r = (area, finding, signal, label = 'fact') => ({ label, confidence: 'medium', sources: [s], asOf: ymd(0), area, finding, signal });
    Object.assign(c, {
      status: 'done', doneAt: new Date().toISOString(), verdict: 'gap', confidence: 'medium', sourceCount: 12,
      verdictText: 'worth closing: two of three competitors have it.', watchFor: 'a competitor changes it',
      rows: [r('features', 'Padlet partial · Wakelet yes', 'against'), r('complaints', 'Mentioned in 9 reviews', 'supports', 'opinion'),
        r('social', 'A few Reddit threads', 'neutral', 'opinion'), r('plans', 'No public plans', 'neutral'), r('pricing', 'Free on all three', 'neutral'),
        r('audience', 'Primary teachers', 'neutral', 'opinion'), r('ai', 'Not relevant', 'neutral')],
    });
    if (idea) idea.checkId = c.id;
    broadcastState();
  }

  /** The approve gate (contract: a done/skipped check younger than checkMaxAgeDays). Returns the 409 message or null. */
  function gate(idea) {
    const live = store.competitors.filter((c) => !c.isUs && !c.removed);
    let c = store.checks.find((x) => x.id === idea.checkId) ?? [...store.checks].reverse().find((x) => x.ideaId === idea.id);
    if (!c && !live.length) {
      c = { id: `IC${store.nextIds.check++}`, ideaId: idea.id, revision: 1, status: 'skipped', rows: [], verdict: 'unclear', verdictText: '', confidence: 'low', sourceCount: 0, capabilityIds: [], skippedReason: 'no competitors tracked', createdAt: new Date().toISOString(), doneAt: new Date().toISOString(), history: [] };
      store.checks.push(c); idea.checkId = c.id; saved();
      return null;
    }
    if (!c) return `${idea.id} has no intel check yet. Run one (Run intel check), then approve.`;
    if (c.status === 'queued' || c.status === 'running') return `The intel check ${c.id} for ${idea.id} is still ${c.status}. Approve when it is done.`;
    if (c.status === 'failed') return `The intel check ${c.id} for ${idea.id} failed. Run it again, then approve.`;
    const max = config.intel?.checkMaxAgeDays ?? 14;
    const age = Date.now() - Date.parse(c.doneAt ?? c.createdAt);
    if (age >= max * 86_400_000) return `The intel check ${c.id} for ${idea.id} is ${Math.floor(age / 86_400_000)} days old (max ${max}). Run a fresh one, then approve.`;
    return null;
  }

  /** On approve: the re-check watch (contract). */
  function approved(idea) {
    const c = store.checks.find((x) => x.id === idea.checkId);
    const cadence = config.intel?.recheck ?? 'weekly';
    if (cadence === 'off') return;
    const w = { id: `W${store.nextIds.watch++}`, subject: { kind: 'idea', ideaId: idea.id }, cadence, ...(c?.watchFor ? { alertOn: c.watchFor } : {}), nextAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), active: true };
    store.watches.push(w);
    idea.watchId = w.id;
    saved();
  }

  function queueJob(body, by = 'you') {
    const id = `IJ${store.nextIds.job++}`;
    const live = store.competitors.filter((c) => !c.isUs && !c.removed);
    const job = {
      id, kind: body.kind, status: 'queued', competitorIds: body.competitorIds ?? live.map((c) => c.id),
      areas: body.areas ?? [...new Set(live.flatMap((c) => c.areas))], browse: body.browse ?? config.researchBrowser.mode, depth: body.depth ?? 'thorough',
      by, queuedAt: new Date().toISOString(), pagesBrowsed: 0, ...(body.ideaId ? { ideaId: body.ideaId } : {}),
    };
    store.jobs.push(job);
    saved();
    dispatch();
    return job;
  }

  // ---------------------------------------------------------------- probe
  function probe(url) {
    let u;
    try { u = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`); } catch { throw new deps.HttpError(400, 'url is not a website'); }
    const host = u.hostname.replace(/^www\./, '');
    const base = `https://${host}`;
    if (host.endsWith('.invalid') || host === 'nothing.example') {
      return { url: base, found: false, legal: [], companies: [], sources: [], notes: ['The site did not answer within 10 s'] };
    }
    if (host === 'boardly.app') {
      return {
        url: base, found: true, name: 'Boardly', tagline: 'Collaborative boards for classrooms', suggestedId: 'boardly',
        legal: [{ name: 'Boardly Learning Ltd', matchedFrom: 'site footer and privacy policy' }],
        companies: [
          { number: '13459821', name: 'BOARDLY LEARNING LTD', status: 'Active', incorporated: '2021-06-14', address: '86-90 Paul Street, London, EC2A 4NE', url: 'https://find-and-update.company-information.service.gov.uk/company/13459821' },
          { number: '11002233', name: 'BOARDLY LIMITED', status: 'Dissolved', incorporated: '2017-10-11', address: '1 Castle Street, Edinburgh, EH2 3AH', url: 'https://find-and-update.company-information.service.gov.uk/company/11002233' },
        ],
        sources: [
          { kind: 'pricing', url: `${base}/pricing`, label: 'Pricing page' }, { kind: 'roadmap', url: 'https://boardly.canny.io', label: 'Public roadmap', note: 'Canny' },
          { kind: 'changelog', url: `${base}/changelog`, label: 'Changelog' }, { kind: 'app_store', url: 'https://apps.apple.com/app/boardly/id1', note: '4.1★ · 2.3k' },
          { kind: 'google_play', url: 'https://play.google.com/store/apps/details?id=app.boardly', note: '3.8★ · 900' }, { kind: 'g2', url: 'https://www.g2.com/products/boardly' },
          { kind: 'reddit', url: 'https://www.reddit.com/r/Teachers/search?q=boardly', label: 'r/Teachers', note: '41 mentions' },
          { kind: 'linkedin', url: 'https://www.linkedin.com/company/boardly', note: '24 staff' }, { kind: 'youtube', url: 'https://www.youtube.com/@boardly', label: 'YouTube · TikTok' },
        ],
        notes: [],
      };
    }
    const name = host.split('.')[0].replace(/^./, (c) => c.toUpperCase());
    return {
      url: base, found: true, name, tagline: undefined, suggestedId: host.split('.')[0], legal: [], companies: [],
      sources: [{ kind: 'pricing', url: `${base}/pricing`, label: 'Pricing page' }], notes: ['No legal name on the home page or footer'],
    };
  }

  // ---------------------------------------------------------------- report
  function report() {
    const lines = [`# Competitive intelligence: ${us.name}`, '', `Generated ${today} from ${summary().sources} sources.`, ''];
    for (const c of store.capabilities) lines.push(`- **${c.name}**: ${c.verdict}${c.verdictVs.length ? ` vs ${c.verdictVs.join(', ')}` : ''}`);
    lines.push('', '## Changes', ...store.changes.map((c) => `- ${c.at} ${c.title} (${c.label}, ${c.confidence}): ${c.implication}`));
    return lines.join('\n') + '\n';
  }

  // research browser state the human writes change (login window, Opera import, forget)
  const browser = {
    state: 'idle', loginSite: undefined,
    sites: [
      { site: 'reddit', label: 'Reddit', domain: 'reddit.com', loginUrl: 'https://www.reddit.com/login', connected: true, via: 'login', checkedAt: iso(30), limits: "Reddit's anonymous JSON is blocked; reads need the login" },
      { site: 'linkedin', label: 'LinkedIn', domain: 'linkedin.com', loginUrl: 'https://www.linkedin.com/login', connected: true, via: 'login', checkedAt: iso(30), warning: 'LinkedIn restricts automated accounts; use a separate account' },
      { site: 'x', label: 'X', domain: 'x.com', loginUrl: 'https://x.com/login', connected: false, checkedAt: iso(30), limits: 'Not set up' },
      { site: 'youtube', label: 'YouTube', domain: 'youtube.com', loginUrl: 'https://accounts.google.com/', connected: false, checkedAt: iso(30), limits: 'yt-dlp is not on PATH: Agent Reach\'s YouTube channel is off' },
      { site: 'g2', label: 'G2', domain: 'g2.com', loginUrl: 'https://www.g2.com/login', connected: false, checkedAt: iso(30) },
    ],
    opera: { found: true, profileDir: 'C:/Users/alex/AppData/Roaming/Opera Software/Opera Stable', imported: undefined, lastImportAt: undefined },
  };
  const browserStatus = () => (process.env.MOCK_BROWSER === 'off'
    ? { available: false, problem: 'playwright-core is not installed', channel: 'chrome', profileDir: 'C:/Users/alex/AppData/Local/muster/research-browser/profile', state: 'idle', sites: [], tools: [], opera: { found: true, allow: config.researchBrowser.operaAllow } }
    : {
        available: true, channel: 'chrome', profileDir: 'C:/Users/alex/AppData/Local/muster/research-browser/profile', state: browser.state,
        ...(browser.loginSite ? { loginSite: browser.loginSite } : {}),
        sites: browser.sites,
        tools: [{ name: 'yt-dlp', ok: false, note: 'not on PATH' }, { name: 'Agent Reach python', ok: true }, { name: 'browser_cookie3', ok: true }, { name: 'Opera profile', ok: true }],
        opera: { ...browser.opera, allow: config.researchBrowser.operaAllow },
      });

  // ---------------------------------------------------------------- routes
  /** Returns { body } (JSON), { text } (Markdown) or undefined when the path isn't an intel route. */
  async function route(req, m, p) {
    let r;
    const body = () => deps.readBody(req);
    if (m === 'GET' && p === '/api/browser') return { body: browserStatus() };
    if (m === 'POST' && p.startsWith('/api/browser/')) {
      const b = await body();
      need(b.actor === 'you', 403, 'Only you can use the research browser login and imports');
      need(process.env.MOCK_BROWSER !== 'off', 409, 'playwright-core is not installed');
      if (p === '/api/browser/login') {
        need(browser.state !== 'login_open', 409, 'A login window is already open: close it first');
        browser.state = 'login_open';
        browser.loginSite = b.site ?? b.url ?? undefined;
        // pretend you signed in and closed the window after a while
        setTimeout(() => {
          if (browser.state !== 'login_open') return;
          const site = browser.sites.find((s) => s.site === browser.loginSite);
          if (site) { site.connected = true; site.via = 'login'; site.checkedAt = new Date().toISOString(); }
          browser.state = 'idle'; delete browser.loginSite;
        }, 8000);
        return { body: browserStatus() };
      }
      if (p === '/api/browser/login/close') { browser.state = 'idle'; delete browser.loginSite; return { body: browserStatus() }; }
      if (p === '/api/browser/forget') {
        const site = browser.sites.find((s) => s.site === b.site);
        need(site, 400, `Unknown site ${b.site}`);
        site.connected = false; delete site.via; site.checkedAt = new Date().toISOString();
        return { body: browserStatus() };
      }
      if (p === '/api/browser/opera-import') {
        const allow = config.researchBrowser.operaAllow;
        const domains = b.domains ?? allow;
        need(domains.length, 400, 'The Opera allowlist is empty');
        for (const d of domains) need(allow.includes(d), 400, `${d} is not in the Opera allowlist`);
        await new Promise((res) => setTimeout(res, 700));
        const counts = { 'reddit.com': 10, 'linkedin.com': 32, 'google.com': 113 };
        browser.opera.imported = Object.fromEntries(domains.map((d) => [d, counts[d] ?? 0]));
        browser.opera.lastImportAt = new Date().toISOString();
        for (const d of domains) { const s = browser.sites.find((x) => x.domain === d); if (s && counts[d]) { s.connected = true; s.via = 'opera'; s.checkedAt = browser.opera.lastImportAt; } }
        return { body: browserStatus() };
      }
    }
    if (!p.startsWith('/api/intel')) return undefined;
    if (m === 'GET' && p === '/api/intel') return { body: store };
    if (m === 'GET' && p === '/api/intel/summary') return { body: summary() };
    if (m === 'GET' && p === '/api/intel/report') return { text: report() };
    if (m === 'POST' && p === '/api/intel/probe') {
      const b = await body();
      need(typeof b.url === 'string' && b.url.trim(), 400, 'url is required');
      await new Promise((res) => setTimeout(res, 900));
      return { body: probe(b.url.trim()) };
    }
    if (m === 'POST' && p === '/api/intel/competitors') {
      const b = await body();
      need(b.actor === 'you', 403, 'Only you can add competitors');
      need(b.name && b.url, 400, 'name and url are required');
      const id = (b.id || b.name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      need(id !== 'us', 400, '"us" is reserved');
      need(!store.competitors.some((c) => c.id === id && !c.removed), 409, `${b.name} is already tracked as ${id}`);
      need(!store.competitors.some((c) => c.url === b.url && !c.removed), 409, `${b.url} is already tracked`);
      const rivalsN = store.competitors.filter((c) => !c.isUs).length;
      const competitor = { id, name: b.name, url: b.url, colour: rivalsN % 8, ...(b.tagline ? { tagline: b.tagline } : {}), ...(b.identity ? { identity: b.identity } : {}), sources: b.sources ?? [], areas: b.areas ?? [], watch: b.watch ?? 'weekly', browse: b.browse ?? 'profile', addedAt: new Date().toISOString() };
      store.competitors.push(competitor);
      if (competitor.watch !== 'off') store.watches.push({ id: `W${store.nextIds.watch++}`, subject: { kind: 'competitor', competitorId: id }, cadence: competitor.watch, nextAt: new Date(Date.now() + 7 * 86_400_000).toISOString(), active: true });
      const job = b.start ? queueJob({ kind: 'competitor', competitorIds: [id], areas: competitor.areas, browse: competitor.browse, depth: b.depth }) : undefined;
      saved();
      return { body: { competitor, ...(job ? { job } : {}) } };
    }
    if ((r = /^\/api\/intel\/competitors\/([^/]+)$/.exec(p))) {
      const c = store.competitors.find((x) => x.id === decodeURIComponent(r[1]));
      need(c, 404, `No competitor ${r[1]}`);
      const b = await body();
      need(b.actor === 'you', 403, 'Only you can change competitors');
      if (m === 'DELETE') { need(!c.isUs, 400, "You can't remove us"); c.removed = true; c.watch = 'off'; saved(); return { body: { ok: true } }; }
      if (m === 'PATCH') { for (const k of ['name', 'url', 'sources', 'areas', 'watch', 'browse', 'identity']) if (b[k] !== undefined) c[k] = b[k]; saved(); return { body: c }; }
    }
    if (m === 'POST' && p === '/api/intel/jobs') {
      const b = await body();
      need(b.actor === 'you' || b.actor === 'captain', 403, 'Only you or the Captain can start intel jobs');
      need(b.kind === 'sweep' || b.kind === 'competitor', 400, 'kind must be sweep or competitor');
      need(store.competitors.some((c) => !c.isUs && !c.removed), 409, 'No competitors tracked yet');
      const dup = store.jobs.find((j) => (j.status === 'queued' || j.status === 'running') && j.kind === b.kind && (b.kind === 'sweep' || j.competitorIds.join() === (b.competitorIds ?? []).join()));
      return { body: dup ?? queueJob(b, b.actor) };
    }
    if (m === 'POST' && (r = /^\/api\/intel\/jobs\/([^/]+)\/cancel$/.exec(p))) {
      const j = store.jobs.find((x) => x.id === decodeURIComponent(r[1]));
      need(j, 404, `No job ${r[1]}`);
      need(j.status === 'queued' || j.status === 'running', 409, `${j.id} is ${j.status}`);
      j.status = 'cancelled';
      j.finishedAt = new Date().toISOString();
      saved();
      dispatch();
      return { body: j };
    }
    if (m === 'POST' && p === '/api/intel/checks') {
      const b = await body();
      need(b.actor === 'you' || b.actor === 'captain', 403, 'Only you or the Captain can request an intel check');
      const idea = state.research.ideas.find((i) => i.id === b.ideaId);
      need(idea, 404, `No idea ${b.ideaId}`);
      const pending = store.checks.find((c) => c.ideaId === idea.id && (c.status === 'queued' || c.status === 'running'));
      if (pending) return { body: pending };
      const live = store.competitors.filter((c) => !c.isUs && !c.removed);
      const base = { id: `IC${store.nextIds.check++}`, ideaId: idea.id, revision: 1, rows: [], verdict: 'unclear', verdictText: '', confidence: 'low', sourceCount: 0, capabilityIds: [], createdAt: new Date().toISOString(), history: [] };
      if (!live.length) {
        const check = { ...base, status: 'skipped', skippedReason: 'no competitors tracked', doneAt: base.createdAt };
        store.checks.push(check); idea.checkId = check.id; saved(); broadcastState();
        return { body: check };
      }
      const check = { ...base, status: 'queued' };
      store.checks.push(check);
      const job = queueJob({ kind: 'check', competitorIds: live.map((c) => c.id), areas: [], ideaId: idea.id }, b.actor);
      check.jobId = job.id;
      check.status = job.status === 'running' ? 'running' : 'queued';
      saved();
      return { body: check };
    }
    if (m === 'POST' && p === '/api/intel/ask') {
      const b = await body();
      need(b.actor === 'you', 403, 'Only you can ask the Captain here');
      need(typeof b.text === 'string' && b.text.trim(), 400, 'text is required');
      const at = new Date().toISOString();
      if (b.ideaId) {
        // = POST /api/research/ideas/:id/ask
        const idea = state.research.ideas.find((i) => i.id === b.ideaId);
        need(idea, 404, `No idea ${b.ideaId}`);
        idea.thread.push({ at, from: 'you', text: b.text.trim() });
        broadcastState();
        setTimeout(() => {
          idea.thread.push({ at: new Date().toISOString(), from: 'captain', text: `It fits ${idea.stageId ?? 'the next stage'}: roughly ${idea.effort === 'L' ? '8' : idea.effort === 'M' ? '5' : '3'} tasks.\n\nNothing else moves if it goes in after the current goal.` });
          idea.plan ??= [`+ Add goal ${idea.title} to ${idea.stageId ?? 'M4'}`];
          toastAll('info', `Captain answered on ${idea.id}`);
          broadcastState();
        }, 2500);
        return { body: idea };
      }
      store.captainThread.push({ at, from: 'you', text: b.text.trim() });
      saved();
      setTimeout(() => {
        store.captainThread.push({ at: new Date().toISOString(), from: 'captain', text: 'R14 and R10 are the quick wins: both fit M3 next to sharing (about 3 and 5 tasks). M3 slips 2 days; launch stays Nov 14.\n\nI would leave R16 parked and test R12 before building it.' });
        toastAll('info', 'Captain answered about the gaps');
        saved();
      }, 2500);
      return { body: store.captainThread };
    }
    if (m === 'POST' && p === '/api/intel/changes/seen') {
      const b = await body();
      for (const c of store.changes) if (!b.ids || b.ids.includes(c.id)) c.seen = true;
      saved();
      return { body: { ok: true } };
    }
    if (m === 'DELETE' && (r = /^\/api\/intel\/watches\/([^/]+)$/.exec(p))) {
      const w = store.watches.find((x) => x.id === decodeURIComponent(r[1]));
      need(w, 404, `No watch ${r[1]}`);
      w.active = false;
      saved();
      return { body: w };
    }
    throw new deps.HttpError(404, `No route ${m} ${p}`);
  }

  return { store, route, summary, gate, approved };
}
