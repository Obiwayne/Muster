// Mock Media for ui/dev/mock-server.mjs (docs/MEDIA.md): a MediaStore with the Vellum "Media" page's sample data,
// the /api/media/* routes and the `media` event. herald "finishes" a queued piece a few seconds after you create it.
//
//   MOCK_MEDIA=none  → nothing written yet, no suggestions (empty library)
//
// Evidence images point at T1/E1/01-after-token-copy.png, the one image the mock serves.

/**
 * @param {{ state: any, now: number, need: Function, HttpError: any, toastAll: Function, readBody: (req: any) => Promise<any>, send: (msg: object) => void }} deps
 */
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
        platforms: ['x', 'linkedin', 'bluesky'],
        posts: [
          { platform: 'x', versions: [POST_X, "One switch, and every post waits for you before the class sees it.\n\nApprove with a tap. Send it back with a note.", 'Moderation is here: posts wait for the teacher.'], chosen: 0 },
          { platform: 'linkedin', versions: [`${POST_X}\n\nWe built it in nine small steps over two weeks, and tested it with three primary classes before switching it on for everyone.`, 'Approve-before-publish is live on every wall.'], chosen: 0 },
          { platform: 'bluesky', versions: ["Teachers asked us for one thing: see a post before the class does.\n\nNow every new post can wait for you. One tap approves it, one tap sends it back with a note. It's live on every wall today, free for one class.", 'Moderation is live.'], chosen: 0 },
        ],
        images: [{ ...IMG, caption: 'After · approval queue' }, { ...IMG, caption: 'Approve / send back buttons' }],
        claims: claimsSocial, editedAt: iso(2),
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
        about: [{ kind: 'task', ref: 'T41', label: 'T41 PDF export' }], platforms: ['x', 'linkedin'], approvedAt: iso(1400),
        posts: [{ platform: 'x', versions: ['Export a whole wall as a PDF. One click.', 'PDF export is here.'], chosen: 0 }, { platform: 'linkedin', versions: ['You can now export a whole wall as a PDF, ready to print for parents evening.'], chosen: 0 }],
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
    nextIds: { piece: 7, suggestion: 4 },
  };

  const summary = () => {
    const working = store.pieces.find((p) => p.status === 'drafting');
    return {
      rev: store.rev,
      review: store.pieces.filter((p) => p.status === 'review').length,
      drafting: store.pieces.filter((p) => p.status === 'drafting' || p.status === 'queued').length,
      openSuggestions: store.suggestions.filter((s) => s.status === 'open').length,
      ...(working ? { working: { id: working.id, title: working.title, progress: working.progress } } : {}),
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
        p.posts = (p.platforms ?? ['x']).map((platform) => ({ platform, versions: [`(mock) ${p.title}. Live today.`, `(mock) ${p.title}.`, '(mock) Short version.'], chosen: 0 }));
        p.images = [{ ...IMG, caption: 'From T1 evidence' }];
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

  function newPiece(b, suggestionId) {
    const id = `MP${store.nextIds.piece++}`;
    const about = (b.about ?? []).map((a) => ({ kind: a.kind, ref: a.ref, label: a.label ?? a.ref }));
    const p = {
      id, kind: b.kind, title: `New ${b.kind === 'social' ? 'social post' : b.kind === 'video' ? 'video script' : b.kind} about ${about.map((a) => a.label).join(', ') || 'recent work'}`,
      status: 'queued', about, ...(b.note ? { note: b.note } : {}), ...(b.kind === 'social' ? { platforms: b.platforms ?? ['x', 'linkedin', 'bluesky'] } : {}),
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
      need(['social', 'article', 'website', 'video'].includes(b.kind), 400, 'kind must be social, article, website or video');
      need(Array.isArray(b.about) && b.about.length, 400, 'Pick what it is about');
      const piece = newPiece(b, b.suggestionId);
      if (b.suggestionId) { const s = store.suggestions.find((x) => x.id === b.suggestionId); if (s) { s.status = 'accepted'; s.pieceIds = [piece.id]; } }
      commit();
      return piece;
    }
    let mm = /^\/api\/media\/pieces\/([^/]+)(?:\/(edit|ask|approve|used|retry))?$/.exec(p);
    if (mm) {
      const piece = find(decodeURIComponent(mm[1]));
      const act = mm[2];
      if (m === 'DELETE' && !act) { store.pieces = store.pieces.filter((x) => x !== piece); commit(); return { ok: true }; }
      need(m === 'POST', 404, `No route ${m} ${p}`);
      if (act === 'edit') {
        need(piece.status !== 'drafting' && piece.status !== 'queued', 409, 'herald is writing it: wait until it is done');
        for (const k of ['title', 'posts', 'sections', 'hooks', 'hookChosen', 'shots', 'target', 'images']) if (b[k] !== undefined) piece[k] = b[k];
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
    need(false, 404, `No media route ${m} ${p}`);
  }

  return { store, route, summary };
}
