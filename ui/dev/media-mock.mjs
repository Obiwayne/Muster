// Mock Media for ui/dev/mock-server.mjs (docs/MEDIA.md): a MediaStore with the Vellum "Media" page's sample data,
// the /api/media/* routes and the `media` event. herald "finishes" a queued piece a few seconds after you create it.
//
//   MOCK_MEDIA=none  → nothing written yet, no suggestions (empty library)
//
// Evidence images point at T1/E1/01-after-token-copy.png, the one image the mock serves. Demo GIFs serve
// ui/dev/fixtures/demo.gif (GET /api/media/pieces/:id/gif returns { file } for mock-server.mjs to stream).

/**
 * @param {{ state: any, now: number, need: Function, HttpError: any, toastAll: Function, readBody: (req: any) => Promise<any>, send: (msg: object) => void }} deps
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const GIF = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'demo.gif');
const PNG = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs', 'design', 'design-system.png'); // stands in for every Vellum post image
const gifFileInfo = (name, at) => ({ name, bytes: 1.8 * 1024 * 1024, width: 800, height: 500, seconds: 9.5, renderedAt: at });

export function createMediaMock(deps) {
  const { now, need, send, toastAll } = deps;
  const MODE = process.env.MOCK_MEDIA ?? 'full';
  const iso = (minAgo) => new Date(now - minAgo * 60_000).toISOString();
  const IMG = { taskId: 'T1', evidenceId: 'E1', name: '01-after-token-copy.png' };
  const src = (kind, ref, label) => ({ kind, ref, label });
  const piece = (id, kind, title, status, minAgo, extra = {}) => ({
    id, kind, title, status, about: [{ kind: 'stage', ref: 'M3', label: 'Stage M3 · Moderation' }], claims: [], requests: [],
    createdAt: iso(minAgo + 30), updatedAt: iso(minAgo), ...extra,
  });

  const POST_X = "Teachers asked for one thing more than any other: see a post before the whole class does.\n\nIt's live now. Turn on approval for a wall and every new post waits for you. One tap approves it, one tap sends it back with a note.\n\nNo more cleaning up after the fact.";
  const claimsSocial = [
    { id: 'C1', quote: 'Teachers asked for one thing more than any other', sources: [src('intel', 'IC4', 'intel · #1 complaint')] },
    { id: 'C2', quote: 'Turn on approval for a wall and every new post waits', sources: [src('task', 'T38', 'T38 merged'), src('task', 'T40', 'T40 merged')] },
    { id: 'C3', quote: 'One tap sends it back with a note', sources: [src('task', 'T43', 'T43 merged'), src('evidence', 'T43/E2', 'screenshot 2')] },
    { id: 'C4', quote: 'No more cleaning up after the fact', sources: [src('opinion', '', 'opinion · your voice')] },
  ];

  const store = {
    version: 1, rev: 1, houseStyle: "Plain words, no hype, short sentences. Name the real feature, show the screenshot, say who it helps. No em dashes, no 'not X but Y', no rule-of-three lists, no 'game-changer', 'seamless', 'unlock', 'elevate'.",
    pieces: MODE === 'none' ? [] : [
      piece('MP6', 'social', 'Teachers now approve every post before the class sees it', 'review', 12, {
        platforms: ['x', 'linkedin', 'facebook', 'instagram', 'bluesky'],
        posts: [
          { platform: 'x', versions: [POST_X, "One switch, and every post waits for you before the class sees it.\n\nApprove with a tap. Send it back with a note.", 'Moderation is here: posts wait for the teacher.'], chosen: 0, hashtags: ['edtech', 'teachers'] },
          { platform: 'linkedin', versions: [`${POST_X}\n\nWe built it in nine small steps over two weeks, and tested it with three primary classes before switching it on for everyone.`, 'Approve-before-publish is live on every wall.'], chosen: 0, hashtags: ['edtech', 'primaryteachers', 'classroom', 'teachertools'] },
          { platform: 'facebook', versions: [`${POST_X}\n\nIt's free for one class. Try it on your next wall.`, 'Every post can now wait for the teacher.'], chosen: 0, hashtags: ['edtech', 'teachers'] },
          { platform: 'instagram', versions: ["See every post before your class does.\n\nTurn on approval for a wall and new posts wait for you. One tap approves, one tap sends it back with a note.", 'Approve before publish.'], chosen: 0, hashtags: ['edtech', 'teachersofinstagram', 'primaryteacher', 'classroomideas', 'ukteachers', 'teachertips', 'ks2'] },
          { platform: 'bluesky', versions: ["Teachers asked us for one thing: see a post before the class does.\n\nNow every new post can wait for you. One tap approves it, one tap sends it back with a note. Live on every wall today.", 'Moderation is live.'], chosen: 0, hashtags: ['edtech'] },
        ],
        designs: [
          { id: 'D1', platform: 'x', file: 'x-1600x900.png', width: 1600, height: 900, style: 'headline', caption: 'See every post before your class does', vellum: { fileId: '8V7QQL6Wu92h', pageId: 'p-1', nodeId: '120-0' }, createdAt: iso(10) },
          { id: 'D2', platform: 'instagram', file: 'instagram-1080x1080.png', width: 1080, height: 1080, style: 'headline', caption: 'See every post before your class does', vellum: { fileId: '8V7QQL6Wu92h', pageId: 'p-1', nodeId: '121-0' }, createdAt: iso(10) },
        ],
        research: {
          at: iso(60), platforms: ['x', 'linkedin', 'facebook'], query: ['class wall', 'student posts', 'moderation'], read: { posts: 46, articles: 9 },
          top: [
            { platform: 'linkedin', text: "I stopped using class walls after one bad post went up during a lesson. Here's what I do instead…", who: 'Primary teacher', engagement: '2.1k reactions, 340 comments', url: 'https://www.linkedin.com/feed/', at: '2026-10-02' },
            { platform: 'x', text: 'Padlet moderation is on by default now? Anyone know if it holds comments too?', who: 'EdTech account', engagement: '410 likes, 88 replies', url: 'https://x.com/', at: '2026-10-05' },
            { platform: 'article', text: '5 safe ways to use online walls in KS2 (Teach Primary)', who: 'Shared widely in teacher groups', url: 'https://www.teachprimary.com/', at: '2026-09-16' },
          ],
          themes: [
            { text: 'Worry about something inappropriate appearing live in front of the class', count: 31 },
            { text: 'Free plans with too few walls', count: 14 },
            { text: 'Pupils needing an email to sign in', count: 9 },
          ],
          hashtags: [
            { tag: 'edtech', platforms: ['x', 'linkedin', 'facebook'], note: 'busy' },
            { tag: 'primaryteachers', platforms: ['linkedin'], note: 'good fit' },
            { tag: 'UKEdChat', platforms: ['x'], note: 'weekly chat' },
          ],
          used: [
            'Opened with the worry teachers raise most (31 mentions), not with the feature.',
            'Mentioned "no pupil emails": it is a common complaint and you already have it.',
            'Left out price talk: posts that lead with "free" get fewer comments here.',
          ],
        },
        images: [{ ...IMG, caption: 'After · approval queue' }, { ...IMG, caption: 'Approve / send back buttons' }],
        gifIds: ['MP7'],
        claims: claimsSocial, editedAt: iso(2),
      }),
      piece('MP7', 'gif', "Demo: approve a student's post in one tap", 'review', 30, {
        about: [{ kind: 'task', ref: 'T38', label: 'T38 Approval queue' }, { kind: 'task', ref: 'T43', label: 'T43 Approve and send back' }],
        gif: {
          source: 'slideshow',
          frames: [
            { ...IMG, caption: 'A student posts', seconds: 2 },
            { ...IMG, caption: 'New posts wait for you first', seconds: 2.5 },
            { ...IMG, caption: 'One tap approves it', seconds: 2.5 },
            { ...IMG, caption: "It's on the class wall", seconds: 2.5 },
          ],
          steps: ['Open a wall with approval switched on', 'As a student, post "My volcano diagram"', 'As the teacher, open the queue and tap Approve', 'Show the post arriving on the class wall'],
          altText: 'A student posts to a class wall; the post waits in the teacher\'s approval queue; the teacher taps Approve and it appears on the wall.',
          slideshow: gifFileInfo('slideshow.gif', iso(29)),
        },
        claims: [{ id: 'C1', quote: 'New posts wait for you first', sources: [src('task', 'T38', 'T38 merged')] }, { id: 'C2', quote: 'One tap approves it', sources: [src('task', 'T43', 'T43 merged')] }],
      }),
      piece('MP5', 'website', 'Feature page: Moderation you control', 'review', 60, {
        target: '/features/moderation',
        sections: [
          { id: 'S1', heading: 'Moderation you control', text: 'Every new post waits for you. Approve it with one tap, or send it back with a note.', status: 'done' },
          { id: 'S2', heading: 'Turn it on per wall', text: 'Open a wall, switch on Approve before publish, and you are done.', status: 'done' },
          { id: 'S3', heading: 'Questions', text: 'Does it cost extra? No. It is part of every plan, including the free one.', status: 'done' },
        ],
        claims: [{ id: 'C1', quote: 'Every new post waits for you', sources: [src('task', 'T38', 'T38 merged')] }, { id: 'C2', quote: 'part of every plan, including the free one', sources: [] }],
      }),
      piece('MP4', 'article', 'How we built approve-before-publish (and why teachers asked for it)', 'drafting', 0, {
        progress: 'writing section 3 of 5', note: 'Aim it at primary teachers.',
        sections: [
          { id: 'S1', heading: '', text: 'In our first round of teacher interviews, the same worry came up again and again. A student posts something, and thirty classmates see it before the teacher does.', status: 'done' },
          { id: 'S2', heading: 'What we built', text: "Every wall now has an approval switch. When it's on, new posts land in a queue only the teacher sees. Approve puts the post on the wall. Send back returns it to the student with a short note.", status: 'done' },
          { id: 'S3', heading: 'The hard part', text: 'Live walls update for everyone at once, so a held post has to stay invisible to students while it', status: 'writing' },
          { id: 'S4', heading: 'Before and after', text: '', status: 'todo' },
          { id: 'S5', heading: "What's next", text: '', status: 'todo' },
        ],
        claims: [
          { id: 'C1', quote: 'the same worry came up again and again', sources: [src('intel', 'IC4', 'intel · #1 complaint')] },
          { id: 'C2', quote: 'Every wall now has an approval switch', sources: [src('task', 'T38', 'T38 merged'), src('task', 'T40', 'T40 merged')] },
          { id: 'C3', quote: 'Send back returns it to the student with a short note', sources: [src('task', 'T43', 'T43 merged'), src('evidence', 'T43/E2', 'screenshot 2')] },
          { id: 'C4', quote: 'thirty classmates see it before the teacher does', sources: [] },
        ],
      }),
      piece('MP3', 'video', '60 seconds: from a blank wall to a class wall', 'approved', 180, {
        hooks: ['This is a class wall on Monday morning. Empty.', 'Thirty students. One wall. What could go wrong?', 'Teachers asked us for one button.'], hookChosen: 0, approvedAt: iso(170),
        shots: [
          { at: '0:00', shot: 'empty wall', voiceover: 'This is a class wall on Monday morning. Empty.', onScreen: 'HOOK · "Monday, 8:59"', evidence: IMG },
          { at: '0:04', shot: 'posts arriving', voiceover: "By 9:05 there are thirty posts on it, and you haven't read one of them yet.", onScreen: 'Counter ticks 0 → 30', evidence: IMG },
          { at: '0:11', shot: 'approval queue', voiceover: "So now there's a switch. New posts wait here, and only you can see them.", onScreen: '"Approve before publish"', evidence: IMG },
          { at: '0:19', shot: 'phone, real class', voiceover: 'One tap and the post is on the wall. One tap and it goes back with a note.', onScreen: 'Tap sounds, no music', record: true },
          { at: '0:26', shot: 'student sees note', voiceover: 'The student sees why, fixes it, and posts again.', record: true },
          { at: '0:34', shot: 'settings switch', voiceover: 'It takes one switch per wall.', evidence: IMG },
          { at: '0:58', shot: 'logo', voiceover: 'Free for one class. Link below.', onScreen: 'wall-education.com', record: true },
        ],
        claims: [],
      }),
      piece('MP2', 'social', 'Export a whole wall as a PDF, one click', 'approved', 1440, {
        about: [{ kind: 'task', ref: 'T41', label: 'T41 PDF export' }], approvedAt: iso(1400),
        platforms: ['x', 'linkedin', 'facebook'],
        posts: [
          { platform: 'x', versions: ['Export a whole wall as a PDF. One click.', 'PDF export is here.'], chosen: 0, hashtags: ['edtech', 'teachers'] },
          { platform: 'linkedin', versions: ['You can now export a whole wall as a PDF, ready to print for parents evening.'], chosen: 0, hashtags: ['edtech', 'primaryteachers', 'classroom'] },
          { platform: 'facebook', versions: ['Export a whole wall as a PDF in one click, ready to print for parents evening.'], chosen: 0, hashtags: ['teachers'] },
        ],
        images: [{ ...IMG, caption: 'Export menu' }], claims: [{ id: 'C1', quote: 'Export a whole wall as a PDF', sources: [src('task', 'T41', 'T41 merged')] }],
      }),
      piece('MP1', 'website', 'Changelog — week of 28 Sep', 'used', 7200, {
        target: '/changelog', usedAt: iso(7000),
        sections: [{ id: 'S1', heading: 'Week of 28 Sep', text: 'Invite links for co-teachers.\n\nFaster wall loading on school Wi-Fi.', status: 'done' }],
      }),
    ],
    suggestions: MODE === 'none' ? [] : [
      { id: 'MS3', trigger: 'stage', ref: 'M3', title: 'Moderation is live: teachers approve posts before the class sees them', summary: 'Article + 3 social posts + a changelog entry. Built from 9 merged tasks and 6 before/after screenshots.', plan: [{ kind: 'article' }, { kind: 'social', platforms: ['x', 'linkedin', 'bluesky'] }, { kind: 'website' }], about: [{ kind: 'stage', ref: 'M3', label: 'Stage M3 · Moderation' }], status: 'open', createdAt: iso(120) },
      { id: 'MS2', trigger: 'feature', ref: 'T41', title: 'One-click PDF export of a whole wall', summary: 'Social posts for X and LinkedIn with the export GIF, plus a feature page section for the website.', plan: [{ kind: 'social', platforms: ['x', 'linkedin'] }, { kind: 'website' }], about: [{ kind: 'task', ref: 'T41', label: 'T41 PDF export' }], status: 'open', createdAt: iso(1300) },
      { id: 'MS1', trigger: 'weekly', ref: '2026-W40', title: 'Week 40: 17 tasks merged, roadmap 38% → 52%', summary: 'A devlog article and a 60-second video script. Herald only suggests a roundup in weeks with 5 or more merged tasks.', plan: [{ kind: 'article' }, { kind: 'video' }], about: [{ kind: 'range', ref: '2026-09-28..2026-10-04', label: '28 Sep to 4 Oct' }], status: 'open', createdAt: iso(4000) },
    ],
    conversations: MODE === 'none' ? [] : [
      {
        id: 'MC1', pieceId: 'MP6', platform: 'x', kind: 'thread', url: 'https://x.com/', who: 'EdTech account', engagement: '410 likes, 88 replies',
        quote: 'Padlet moderation is on by default now? Anyone know if it holds comments too?', why: 'Reply to a question · 2 days ago',
        draft: "Not sure about Padlet's comments, but this was the #1 thing teachers asked us for too. In wall-education (my project, early testing) held posts and comments stay invisible to pupils until you approve them.",
        claims: [{ id: 'C1', quote: 'held posts and comments stay invisible to pupils until you approve them', sources: [src('task', 'T38', 'T38 merged')] }],
        mentionsProduct: true, status: 'draft', createdAt: iso(50),
      },
      {
        id: 'MC2', pieceId: 'MP6', platform: 'linkedin', kind: 'own', url: 'https://www.linkedin.com/feed/', who: 'Year 4 teacher',
        quote: 'Does it work on the school iPads? Ours block most sign-ins.', why: 'A question on your post',
        draft: "Good question. Pupils sign in with a class code and a picture, no email, so it doesn't need an account on the iPad. I'd love to test it on yours.",
        claims: [{ id: 'C1', quote: 'Pupils sign in with a class code and a picture', sources: [] }],
        mentionsProduct: false, status: 'draft', createdAt: iso(180),
      },
      {
        id: 'MC3', pieceId: 'MP6', platform: 'facebook', kind: 'thread', url: 'https://www.facebook.com/groups/', who: 'Primary Teachers UK group',
        quote: 'What do you all use instead of Padlet now? Need something safe for KS2.', why: 'Someone asked for a tool · 1 day ago', engagement: '62 comments',
        draft: "We're building one for exactly this (wall-education, my project): every pupil post waits for the teacher before the class sees it. Happy to share it if you want to try it.",
        claims: [{ id: 'C1', quote: 'every pupil post waits for the teacher before the class sees it', sources: [src('task', 'T38', 'T38 merged')] }],
        mentionsProduct: true, status: 'draft', createdAt: iso(300),
      },
    ],
    publish: MODE === 'none' ? [] : [
      { id: 'PJ1', pieceId: 'MP2', platform: 'x', kind: 'post', text: 'Export a whole wall as a PDF. One click.\n\n#edtech #teachers', images: ['C:\\repo\\.muster\\evidence\\T1\\E1\\01-after-token-copy.png'], status: 'ready', composer: 'Export a whole wall as a PDF. One click.\n\n#edtech #teachers', attached: 1, createdAt: iso(3), updatedAt: iso(1) },
      { id: 'PJ2', pieceId: 'MP2', platform: 'linkedin', kind: 'post', text: 'You can now export a whole wall as a PDF, ready to print for parents evening.\n\n#edtech #primaryteachers #classroom', images: [], status: 'filling', createdAt: iso(3), updatedAt: iso(1) },
      { id: 'PJ3', pieceId: 'MP2', platform: 'facebook', kind: 'post', text: 'Export a whole wall as a PDF in one click.\n\n#teachers', images: [], status: 'queued', createdAt: iso(3), updatedAt: iso(3) },
    ],
    replyPolicy: { perDay: 5, watchOwn: true },
    nextIds: { piece: 8, suggestion: 4, conversation: 4, publish: 4 },
  };


  const summary = () => {
    const working = store.pieces.find((p) => p.status === 'drafting');
    return {
      rev: store.rev,
      review: store.pieces.filter((p) => p.status === 'review').length,
      drafting: store.pieces.filter((p) => p.status === 'drafting' || p.status === 'queued').length,
      openSuggestions: store.suggestions.filter((s) => s.status === 'open').length,
      ...(working ? { working: { id: working.id, title: working.title, progress: working.progress } } : {}),
      conversations: store.conversations.filter((c) => c.status === 'draft').length,
      publishReady: store.publish.filter((j) => j.status === 'ready').length,
    };
  };
  const commit = () => { store.rev++; send({ type: 'media', rev: store.rev, summary: summary() }); };
  const find = (id) => { const p = store.pieces.find((x) => x.id === id); need(p, 404, `No piece ${id}`); return p; };
  const stamp = (p) => { p.updatedAt = new Date().toISOString(); };

  /** herald "writes" a queued piece: drafting for a few seconds, then review with sample text. */
  function fakeHerald(p) {
    setTimeout(() => { p.status = 'drafting'; p.progress = 'reading the brief'; stamp(p); commit(); }, 800);
    setTimeout(() => {
      p.status = 'review';
      delete p.progress;
      if (p.kind === 'social') {
        p.posts = (p.platforms ?? ['x']).map((platform) => ({ platform, versions: [`(mock) ${p.title}. Live today.`, `(mock) ${p.title}.`, '(mock) Short version.'], chosen: 0, hashtags: ['edtech'] }));
        p.images = [{ ...IMG, caption: 'From T1 evidence' }];
      } else if (p.kind === 'gif') {
        p.gif = {
          source: 'slideshow',
          frames: [{ ...IMG, caption: '(mock) First frame', seconds: 2.5 }, { ...IMG, caption: '(mock) Second frame', seconds: 2.5 }],
          steps: ['(mock) Open the app', '(mock) Do the thing'], altText: '(mock) What the GIF shows.',
          slideshow: gifFileInfo('slideshow.gif', new Date().toISOString()),
        };
      } else if (p.kind === 'video') {
        p.hooks = ['(mock) Hook one.', '(mock) Hook two.', '(mock) Hook three.']; p.hookChosen = 0;
        p.shots = [{ at: '0:00', shot: 'opening', voiceover: '(mock) Voiceover.', evidence: IMG }, { at: '0:05', shot: 'you on camera', voiceover: '(mock) More.', record: true }];
      } else {
        p.sections = [{ id: 'S1', heading: '', text: '(mock) Opening paragraph.', status: 'done' }, { id: 'S2', heading: 'What we built', text: '(mock) Body.', status: 'done' }];
      }
      p.claims = [{ id: 'C1', quote: '(mock) Live today', sources: [src('task', 'T1', 'T1 merged')] }];
      for (const r of p.requests) r.doneAt ??= new Date().toISOString();
      if (p.title.startsWith('New ')) p.title = `(mock) ${p.title.slice(4)}`;
      stamp(p);
      commit();
      toastAll('info', `herald finished ${p.id} · ${p.title}`);
    }, 5000);
  }

  /** herald "fills in" a post or reply in Chrome: filling, then ready with the text read back. */
  function fakeFill(job, n) {
    const t0 = 1200 + (n - 1) * 3000;
    setTimeout(() => { if (job.status !== 'queued') return; job.status = 'filling'; job.updatedAt = new Date().toISOString(); commit(); }, t0);
    setTimeout(() => {
      if (job.status !== 'filling') return;
      job.status = 'ready'; job.composer = job.text; job.attached = job.images.length; job.updatedAt = new Date().toISOString();
      commit();
      toastAll('info', `${job.platform === 'x' ? 'X' : job.platform} ${job.kind} ready: check the tab in Chrome and press Post in Muster`);
    }, t0 + 2500);
  }

  /** Research again, or Make an image (Vellum): herald does it a few seconds later. */
  function pieceExtra(piece, act, b) {
    need(piece.kind === 'social', 400, 'Only a social post');
    need(piece.status !== 'drafting' && piece.status !== 'queued', 409, 'herald is writing it: wait until it is done');
    if (act === 'research') {
      piece.status = 'drafting'; piece.progress = 'researching X, LinkedIn and Facebook';
      setTimeout(() => { piece.status = 'review'; delete piece.progress; if (piece.research) piece.research.at = new Date().toISOString(); stamp(piece); commit(); }, 4000);
    } else {
      need(['headline', 'features', 'quote'].includes(b.style), 400, 'style is headline, features or quote');
      const platforms = b.platforms?.length ? b.platforms : piece.posts.map((x) => x.platform);
      piece.designRequest = { style: b.style, ...(b.note ? { note: b.note } : {}), platforms, at: new Date().toISOString() };
      const size = { x: [1600, 900], linkedin: [1200, 627], facebook: [1200, 630], instagram: [1080, 1080], threads: [1080, 1350], bluesky: [1600, 900] };
      setTimeout(() => {
        const kept = (piece.designs ?? []).filter((d) => !platforms.includes(d.platform));
        piece.designs = [...kept, ...platforms.map((pl, i) => ({ id: `D${kept.length + i + 1}`, platform: pl, file: `${pl}-${size[pl][0]}x${size[pl][1]}.png`, width: size[pl][0], height: size[pl][1], style: b.style, caption: piece.title, vellum: { fileId: '8V7QQL6Wu92h', nodeId: `${200 + i}-0` }, createdAt: new Date().toISOString() }))];
        delete piece.designRequest;
        stamp(piece); commit();
        toastAll('info', `herald made ${platforms.length} images in Vellum for ${piece.id}`);
      }, 5000);
    }
    stamp(piece); commit();
    return piece;
  }

  function newPiece(b, suggestionId) {
    const id = `MP${store.nextIds.piece++}`;
    const about = (b.about ?? []).map((a) => ({ kind: a.kind, ref: a.ref, label: a.label ?? a.ref }));
    const p = {
      id, kind: b.kind, title: `New ${b.kind === 'social' ? 'social post' : b.kind === 'video' ? 'video script' : b.kind === 'gif' ? 'demo GIF' : b.kind} about ${about.map((a) => a.label).join(', ') || 'recent work'}`,
      status: 'queued', about, ...(b.note ? { note: b.note } : {}), ...(b.kind === 'social' ? { platforms: b.platforms ?? ['x', 'linkedin', 'facebook'] } : {}),
      claims: [], requests: [], ...(suggestionId ? { suggestionId } : {}), createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    };
    store.pieces.push(p);
    fakeHerald(p);
    return p;
  }

  async function route(req, m, p) {
    if (m === 'GET' && p === '/api/media') return store;
    if (m === 'GET' && p === '/api/media/summary') return summary();
    const b = m === 'GET' ? {} : await deps.readBody(req);
    if (m === 'POST' && p === '/api/media/pieces') {
      need(['social', 'article', 'website', 'video', 'gif'].includes(b.kind), 400, 'kind must be social, article, website, video or gif');
      need(Array.isArray(b.about) && b.about.length, 400, 'Pick what it is about');
      const piece = newPiece(b, b.suggestionId);
      if (b.suggestionId) { const s = store.suggestions.find((x) => x.id === b.suggestionId); if (s) { s.status = 'accepted'; s.pieceIds = [piece.id]; } }
      commit();
      return piece;
    }
    let mm = /^\/api\/media\/pieces\/([^/]+)\/gif$/.exec(p);
    if (mm && m === 'GET') {
      const piece = find(decodeURIComponent(mm[1]));
      need(piece.gif && (piece.gif.slideshow || piece.gif.recording?.file), 404, `${piece.id} has no GIF yet`);
      return { file: readFileSync(GIF), type: 'image/gif' };
    }
    mm = /^\/api\/media\/pieces\/([^/]+)\/designs\/([^/]+)$/.exec(p);
    if (mm && m === 'GET') {
      const piece = find(decodeURIComponent(mm[1]));
      need((piece.designs ?? []).some((d) => d.file === decodeURIComponent(mm[2])), 404, 'No such image');
      return { file: readFileSync(PNG), type: 'image/png' };
    }
    mm = /^\/api\/media\/pieces\/([^/]+)\/(research|design)$/.exec(p);
    if (mm && m === 'POST') return pieceExtra(find(decodeURIComponent(mm[1])), mm[2], b);
    mm = /^\/api\/media\/pieces\/([^/]+)(?:\/(edit|ask|approve|used|retry|record))?$/.exec(p);
    if (mm) {
      const piece = find(decodeURIComponent(mm[1]));
      const act = mm[2];
      if (m === 'DELETE' && !act) { store.pieces = store.pieces.filter((x) => x !== piece); commit(); return { ok: true }; }
      need(m === 'POST', 404, `No route ${m} ${p}`);
      if (act === 'edit') {
        need(piece.status !== 'drafting' && piece.status !== 'queued', 409, 'herald is writing it: wait until it is done');
        for (const k of ['title', 'posts', 'sections', 'hooks', 'hookChosen', 'shots', 'target', 'images', 'gifIds']) if (b[k] !== undefined) piece[k] = b[k];
        if (b.gif && piece.gif) {
          const framesChanged = b.gif.frames !== undefined && JSON.stringify(b.gif.frames) !== JSON.stringify(piece.gif.frames);
          Object.assign(piece.gif, b.gif);
          if (framesChanged) piece.gif.slideshow = gifFileInfo('slideshow.gif', new Date().toISOString()); // the server re-renders
        }
        piece.editedAt = new Date().toISOString();
        if (piece.status === 'approved') piece.status = 'review';
      } else if (act === 'ask') {
        need(typeof b.text === 'string' && b.text.trim(), 400, 'Say what to change');
        piece.requests.push({ at: new Date().toISOString(), from: 'human', text: b.text.trim() });
        piece.status = 'queued';
        fakeHerald(piece);
      } else if (act === 'approve') {
        need(piece.status === 'review', 409, `${piece.id} is ${piece.status}, not waiting on review`);
        const n = piece.claims.filter((c) => !c.sources.length).length;
        need(!n, 409, `Confirm or cut ${n} unsourced claim${n === 1 ? '' : 's'} first`);
        piece.status = 'approved'; piece.approvedAt = new Date().toISOString();
      } else if (act === 'used') {
        need(piece.status === 'approved', 409, 'Approve it first');
        piece.status = 'used'; piece.usedAt = new Date().toISOString();
      } else if (act === 'record') {
        need(piece.kind === 'gif' && piece.gif, 400, 'Only a demo GIF can be recorded');
        need(!['requested', 'recording'].includes(piece.gif.recording?.status), 409, 'A recording is already on its way');
        piece.gif.recording = { status: 'requested', requestedAt: new Date().toISOString() };
        setTimeout(() => { piece.gif.recording = { ...piece.gif.recording, status: 'recording', taskId: 'T52' }; stamp(piece); commit(); }, 3000);
      } else if (act === 'retry') {
        need(piece.status === 'failed', 409, 'Only a stopped piece can be retried');
        piece.status = 'queued'; delete piece.error; fakeHerald(piece);
      }
      stamp(piece); commit();
      return piece;
    }
    mm = /^\/api\/media\/pieces\/([^/]+)\/claims\/([^/]+)\/confirm$/.exec(p);
    if (mm && m === 'POST') {
      const piece = find(decodeURIComponent(mm[1]));
      const c = piece.claims.find((x) => x.id === decodeURIComponent(mm[2]));
      need(c, 404, 'No such claim');
      c.sources = [src('opinion', '', 'opinion · your voice')];
      stamp(piece); commit();
      return piece;
    }
    if (m === 'PUT' && p === '/api/media/style') { store.houseStyle = String(b.text ?? '').slice(0, 4000); commit(); return { ok: true }; }
    if (m === 'POST' && p === '/api/media/suggestions/dismiss-all') { for (const s of store.suggestions) if (s.status === 'open') { s.status = 'dismissed'; s.decidedAt = new Date().toISOString(); } commit(); return { ok: true }; }
    mm = /^\/api\/media\/suggestions\/([^/]+)\/(accept|dismiss)$/.exec(p);
    if (mm && m === 'POST') {
      const s = store.suggestions.find((x) => x.id === decodeURIComponent(mm[1]));
      need(s, 404, 'No such suggestion');
      need(s.status === 'open', 409, `${s.id} is already ${s.status}`);
      s.decidedAt = new Date().toISOString();
      if (mm[2] === 'dismiss') s.status = 'dismissed';
      else {
        s.status = 'accepted';
        s.pieceIds = s.plan.map((pl) => newPiece({ kind: pl.kind, platforms: pl.platforms, about: s.about }).id);
      }
      commit();
      return s;
    }
    // ---- posting through your Chrome, conversations, reply policy (docs/MEDIA.md, 2026-10-07) ----
    if (m === 'POST' && p === '/api/media/publish') {
      const piece = find(b.pieceId);
      need(piece.kind === 'social' && (piece.status === 'approved' || piece.status === 'used'), 409, 'Approve it first');
      need(Array.isArray(b.platforms) && b.platforms.length, 400, 'Pick at least one platform');
      for (const pl of b.platforms) {
        const post = piece.posts?.find((x) => x.platform === pl);
        need(post, 400, `No ${pl} post`);
        const images = (piece.designs ?? []).filter((d) => d.platform === pl).length || (piece.images ?? []).length;
        need(pl !== 'instagram' || images, 400, 'Instagram needs an image');
        for (const j of store.publish) if (j.pieceId === piece.id && j.platform === pl && ['queued', 'filling', 'ready', 'posting', 'signin', 'failed'].includes(j.status)) j.status = 'cancelled';
        const tags = (post.hashtags ?? []).map((t) => `#${t}`).join(' ');
        const text = tags ? `${post.versions[post.chosen]}\n\n${tags}` : post.versions[post.chosen];
        const job = { id: `PJ${store.nextIds.publish++}`, pieceId: piece.id, platform: pl, kind: 'post', text, images: Array.from({ length: images }, (_, i) => `C:\\img${i}.png`), status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        store.publish.push(job);
        fakeFill(job, store.publish.filter((x) => x.status === 'queued').length);
      }
      commit();
      return { ok: true };
    }
    if (m === 'POST' && p === '/api/media/publish/stop') {
      for (const j of store.publish) if (j.pieceId === b.pieceId && ['queued', 'filling', 'ready', 'signin'].includes(j.status)) { j.status = 'cancelled'; j.updatedAt = new Date().toISOString(); }
      commit();
      return { ok: true };
    }
    mm = /^\/api\/media\/publish\/([^/]+)\/(go|cancel)$/.exec(p);
    if (mm && m === 'POST') {
      const j = store.publish.find((x) => x.id === decodeURIComponent(mm[1]));
      need(j, 404, 'No such post');
      if (mm[2] === 'cancel') { j.status = 'cancelled'; if (j.conversationId) { const c = store.conversations.find((x) => x.id === j.conversationId); if (c) c.status = 'draft'; } }
      else {
        need(j.status === 'ready', 409, 'It is not ready yet');
        j.status = 'posting';
        setTimeout(() => {
          j.status = 'posted'; j.url = j.platform === 'x' ? 'https://x.com/wall_education/status/1840000000000000000' : 'https://www.linkedin.com/feed/update/urn:li:activity:7250000000000000000/';
          j.updatedAt = new Date().toISOString();
          if (j.conversationId) { const c = store.conversations.find((x) => x.id === j.conversationId); if (c) { c.status = 'posted'; c.postedAt = j.updatedAt; c.postedUrl = j.url; } }
          const piece = store.pieces.find((x) => x.id === j.pieceId);
          if (piece && store.publish.filter((x) => x.pieceId === piece.id && x.kind === 'post' && x.status !== 'cancelled').every((x) => x.status === 'posted')) { piece.status = 'used'; piece.usedAt = j.updatedAt; }
          commit();
        }, 2000);
      }
      j.updatedAt = new Date().toISOString();
      commit();
      return j;
    }
    mm = /^\/api\/media\/conversations\/([^/]+)\/(edit|skip|reply)$/.exec(p);
    if (mm && m === 'POST') {
      const c = store.conversations.find((x) => x.id === decodeURIComponent(mm[1]));
      need(c, 404, 'No such conversation');
      if (mm[2] === 'edit') { need(typeof b.draft === 'string', 400, 'draft must be text'); c.draft = b.draft; }
      else if (mm[2] === 'skip') c.status = 'skipped';
      else {
        need(!c.claims.some((x) => !x.sources.length), 409, 'Confirm or cut the unsourced lines first');
        const today = store.publish.filter((j) => j.kind === 'reply' && j.status !== 'cancelled').length;
        need(today < store.replyPolicy.perDay, 409, `Today's limit of ${store.replyPolicy.perDay} replies is reached`);
        c.status = 'queued';
        const job = { id: `PJ${store.nextIds.publish++}`, pieceId: c.pieceId, conversationId: c.id, platform: c.platform, kind: 'reply', text: c.draft, images: [], status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
        store.publish.push(job);
        fakeFill(job, 1);
      }
      commit();
      return c;
    }
    mm = /^\/api\/media\/conversations\/([^/]+)\/claims\/([^/]+)\/confirm$/.exec(p);
    if (mm && m === 'POST') {
      const c = store.conversations.find((x) => x.id === decodeURIComponent(mm[1]));
      need(c, 404, 'No such conversation');
      const cl = c.claims.find((x) => x.id === decodeURIComponent(mm[2]));
      need(cl, 404, 'No such claim');
      cl.sources = [src('opinion', '', 'opinion · your voice')];
      commit();
      return c;
    }
    if (m === 'PUT' && p === '/api/media/reply-policy') {
      if (b.perDay !== undefined) { need(Number.isInteger(b.perDay) && b.perDay >= 0 && b.perDay <= 20, 400, 'perDay is 0 to 20'); store.replyPolicy.perDay = b.perDay; }
      if (b.watchOwn !== undefined) store.replyPolicy.watchOwn = !!b.watchOwn;
      commit();
      return store.replyPolicy;
    }
    need(false, 404, `No media route ${m} ${p}`);
  }

  return { store, route, summary };
}
