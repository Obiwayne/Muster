// Sites the research browser knows: where to sign in, which cookie proves a login, and the honest
// limits Settings → Research browser shows (docs/ARCHITECTURE.md, Competitive intelligence).

export interface KnownSite {
  site: string; // 'reddit'
  label: string; // "Reddit"
  domain: string; // registrable domain, "reddit.com"
  loginUrl: string;
  authCookies: string[]; // a cookie with one of these names on the domain = signed in
  warning?: string;
  limits?: string;
}

export const SITES: KnownSite[] = [
  {
    site: 'reddit',
    label: 'Reddit',
    domain: 'reddit.com',
    loginUrl: 'https://www.reddit.com/login/',
    authCookies: ['reddit_session'],
    limits: "Reddit's anonymous JSON is blocked; reads need the login.",
  },
  {
    site: 'linkedin',
    label: 'LinkedIn',
    domain: 'linkedin.com',
    loginUrl: 'https://www.linkedin.com/login',
    authCookies: ['li_at'],
    warning: 'LinkedIn restricts automated accounts; sign in with a separate account, not your own.',
    limits: 'Read-only: company pages, posts and job counts. Nothing is ever liked, followed or messaged.',
  },
  {
    site: 'x',
    label: 'X (Twitter)',
    domain: 'x.com',
    loginUrl: 'https://x.com/i/flow/login',
    authCookies: ['auth_token'],
    limits: "X is not set up: Agent Reach's X channel is off and X shows little to signed-out readers.",
  },
  {
    site: 'youtube',
    label: 'YouTube',
    domain: 'youtube.com',
    loginUrl: 'https://accounts.google.com/ServiceLogin?service=youtube&continue=https://www.youtube.com/',
    authCookies: ['SAPISID', '__Secure-3PSID', 'LOGIN_INFO'],
    limits: "yt-dlp is not on PATH, so Agent Reach's YouTube channel (search, subtitles) is off until it is. Public channel pages still read.",
  },
  {
    site: 'instagram',
    label: 'Instagram',
    domain: 'instagram.com',
    loginUrl: 'https://www.instagram.com/accounts/login/',
    authCookies: ['sessionid'],
    limits: 'Most profiles show only a few posts without a login.',
  },
  {
    site: 'tiktok',
    label: 'TikTok',
    domain: 'tiktok.com',
    loginUrl: 'https://www.tiktok.com/login',
    authCookies: ['sessionid', 'sid_tt'],
  },
  {
    site: 'facebook',
    label: 'Facebook',
    domain: 'facebook.com',
    loginUrl: 'https://www.facebook.com/login/',
    authCookies: ['c_user', 'xs'],
    limits: 'Pages and groups mostly need a login.',
  },
  {
    site: 'g2',
    label: 'G2',
    domain: 'g2.com',
    loginUrl: 'https://www.g2.com/login',
    authCookies: ['_g2_session_id', 'remember_user_token'],
    limits: 'G2 often blocks automated readers with a bot check; reviews may need several tries.',
  },
];

export function siteByName(site: string): KnownSite | undefined {
  return SITES.find((s) => s.site === site);
}

/** True when `host` is `domain` or one of its subdomains (cookie domains may start with "."). */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/^\.+/, '');
  const d = domain.toLowerCase().replace(/^\.+/, '');
  return h === d || h.endsWith('.' + d);
}

/** Every cookie domain a site uses (X still sets some on twitter.com). */
export function siteDomains(s: KnownSite): string[] {
  return s.site === 'x' ? [s.domain, 'twitter.com'] : [s.domain];
}

/** The known site a URL or host belongs to. twitter.com counts as x.com. */
export function siteForHost(host: string): KnownSite | undefined {
  const h = host.toLowerCase();
  if (hostMatches(h, 'twitter.com')) return siteByName('x');
  return SITES.find((s) => hostMatches(h, s.domain));
}

/** A registrable-looking domain as typed for the Opera allowlist ("https://www.Reddit.com/" → "reddit.com"), or null. */
export function cleanDomain(input: string): string | null {
  let d = input.trim().toLowerCase();
  d = d.replace(/^[a-z]+:\/\//, '').replace(/[/?#].*$/, '').replace(/:\d+$/, '').replace(/^\.+/, '');
  if (d.startsWith('www.')) d = d.slice(4);
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}
