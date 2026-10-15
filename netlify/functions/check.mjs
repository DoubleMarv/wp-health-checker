// Double Marvellous — WordPress health check.
// Fetches a site's homepage (outside-in, read-only) and returns a scored report.
// Only public pages are requested: the homepage, its http:// version, and the WordPress.org API.

import dns from 'node:dns/promises';
import net from 'node:net';

const UA = 'Mozilla/5.0 (compatible; DoubleMarvellousHealthCheck/1.0; +https://doublemarvellous.com)';
const TIMEOUT_MS = 9000;
const MAX_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const WP_API = process.env.WP_API_BASE || 'https://api.wordpress.org';
const ALLOW_PRIVATE = process.env.ALLOW_PRIVATE_HOSTS === '1'; // local testing only

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

// ---------- Safety: never fetch private/internal addresses ----------
function privateV4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}
function privateIp(ip) {
  if (net.isIPv4(ip)) return privateV4(ip);
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return privateV4(v.slice(7));
  return v === '::' || v === '::1' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe8') ||
    v.startsWith('fe9') || v.startsWith('fea') || v.startsWith('feb');
}
async function assertPublicHost(host) {
  if (ALLOW_PRIVATE) return;
  const h = host.replace(/^\[|\]$/g, '');
  if (/^localhost$|\.local$|\.internal$/i.test(h)) throw new Error('That address isn’t public.');
  const addrs = net.isIP(h) ? [{ address: h }] : await dns.lookup(h, { all: true });
  if (!addrs.length || addrs.some((a) => privateIp(a.address))) throw new Error('That address isn’t public.');
}

function normaliseUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Please enter a website address.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { throw new Error('That doesn’t look like a website address.'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http and https sites can be checked.');
  if (u.username || u.password) throw new Error('Please enter a plain website address.');
  if (u.port && !['80', '443'].includes(u.port) && !ALLOW_PRIVATE) throw new Error('Please enter a standard website address.');
  if (!u.hostname.includes('.') && !ALLOW_PRIVATE) throw new Error('Please enter a full domain, like example.ie.');
  u.hash = '';
  return u;
}

async function readCapped(res) {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks = []; let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > MAX_BYTES) { reader.cancel(); break; }
    chunks.push(value);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks));
}

// Fetch with manual redirects so every hop is checked.
async function fetchPage(startUrl, { firstHopOnly = false } = {}) {
  let url = new URL(startUrl);
  const hops = [];
  const started = Date.now();
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    await assertPublicHost(url.hostname);
    const res = await fetch(url, {
      redirect: 'manual',
      headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      const next = new URL(loc, url);
      hops.push({ from: url.href, to: next.href, status: res.status });
      if (firstHopOnly) return { res, url, hops, ms: Date.now() - started, body: '' };
      if (!/^https?:$/.test(next.protocol)) throw new Error('The site redirected somewhere unexpected.');
      url = next;
      continue;
    }
    const body = firstHopOnly ? '' : await readCapped(res);
    return { res, url, hops, ms: Date.now() - started, body };
  }
  throw new Error('Too many redirects.');
}

// ---------- Helpers ----------
const cmpVer = (a, b) => {
  const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
};
const branch = (v) => String(v).split('.').slice(0, 2).join('.');
function mode(values) {
  const c = {}; let best = null;
  for (const v of values) { c[v] = (c[v] || 0) + 1; if (!best || c[v] > c[best]) best = v; }
  return best;
}
async function getJson(url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': UA }, signal: AbortSignal.timeout(6000) });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

const CONSENT_TOOLS = [
  ['Cookiebot', /cookiebot/i], ['CookieYes', /cookieyes|cookie-law-info/i], ['Complianz', /complianz|cmplz/i],
  ['OneTrust', /onetrust|optanon/i], ['iubenda', /iubenda/i], ['Termly', /termly/i],
  ['Borlabs Cookie', /borlabs/i], ['Cookie Notice', /cookie-notice|cn-cookie/i], ['GDPR Cookie Compliance', /moove_gdpr|gdpr-cookie-compliance/i],
  ['Usercentrics', /usercentrics/i], ['Cookie Script', /cookie-script\.com/i], ['Osano', /osano/i],
  ['CookieFirst', /cookiefirst/i], ['Didomi', /didomi/i], ['Real Cookie Banner', /real-cookie-banner/i],
];
const TRACKERS = [
  ['Google Analytics / Tag Manager', /googletagmanager\.com\/(gtag|gtm)|google-analytics\.com\/(analytics|ga)\.js|gtag\(\s*['"]config/i],
  ['Meta Pixel', /connect\.facebook\.net\/[^"']*fbevents|fbq\(\s*['"]init/i],
  ['Hotjar', /static\.hotjar\.com|hotjar/i],
  ['LinkedIn Insight', /snap\.licdn\.com/i],
];
const BUILDERS = [
  ['Divi', /\/themes\/Divi\/|et_pb_|divi-builder/i], ['Elementor', /elementor/i], ['WPBakery', /js_composer|vc_row/i],
  ['Beaver Builder', /fl-builder/i], ['Oxygen', /oxygen-|ct-section/i], ['Bricks', /bricks-/i], ['Avada', /fusion-builder|Avada/],
];

// ---------- The checks ----------
export default async (req) => {
  if (req.method !== 'POST' && req.method !== 'GET') return json({ ok: false, error: 'Method not allowed' }, 405);
  let input;
  try {
    input = req.method === 'GET'
      ? new URL(req.url).searchParams.get('url')
      : (await req.json()).url;
  } catch { return json({ ok: false, error: 'Bad request' }, 400); }

  let target;
  try { target = normaliseUrl(input); } catch (e) { return json({ ok: false, error: e.message }, 422); }

  // Main fetch (https first; fall back to http if https fails entirely)
  let page, sslProblem = null;
  try {
    page = await fetchPage(target.href);
  } catch (e) {
    if (target.protocol === 'https:') {
      sslProblem = String(e?.cause?.code || e?.message || e);
      try {
        const http = new URL(target.href); http.protocol = 'http:';
        page = await fetchPage(http.href);
      } catch (e2) {
        return json({ ok: false, error: friendlyFetchError(e2, e) }, 502);
      }
    } else {
      return json({ ok: false, error: friendlyFetchError(e) }, 502);
    }
  }
  if (page.res.status >= 400) {
    return json({ ok: false, error: `The site responded with an error (${page.res.status}). It may be blocking automated checks.` }, 502);
  }

  const html = page.body;
  const h = page.res.headers;
  const final = page.url;
  const checks = [];
  const add = (group, id, label, status, detail) => checks.push({ group, id, label, status, detail });

  // --- Security & updates ---
  if (final.protocol === 'https:' && !sslProblem) {
    add('security', 'https', 'Secure connection (HTTPS)', 'pass', 'The site loads over HTTPS.');
  } else if (sslProblem) {
    add('security', 'https', 'Secure connection (HTTPS)', 'fail', 'The secure version of the site failed to load. Visitors may see a “Not secure” warning.');
  } else {
    add('security', 'https', 'Secure connection (HTTPS)', 'fail', 'The site doesn’t use HTTPS. Browsers mark it “Not secure”.');
  }

  if (final.protocol === 'https:') {
    try {
      const http = new URL(final.origin); http.protocol = 'http:';
      const r = await fetchPage(http.href, { firstHopOnly: true });
      const to = r.hops[0]?.to || '';
      if (to.startsWith('https:')) add('security', 'redirect', 'Redirects to the secure version', 'pass', 'Visitors who type http:// are sent to https://.');
      else add('security', 'redirect', 'Redirects to the secure version', 'warn', 'The http:// address doesn’t redirect to https://, so some visitors land on an insecure page.');
    } catch {
      add('security', 'redirect', 'Redirects to the secure version', 'info', 'Couldn’t test the http:// version.');
    }
  }

  const isWP = /\/wp-content\/|\/wp-includes\/|<meta[^>]+generator[^>]+WordPress/i.test(html);
  let wpVersion = null, latestWp = null, plugins = [];

  if (isWP) {
    const gen = html.match(/<meta[^>]+name=["']generator["'][^>]+content=["']WordPress\s*([\d.]+)/i)
      || html.match(/content=["']WordPress\s*([\d.]+)["'][^>]+name=["']generator/i);
    if (gen) wpVersion = gen[1];
    else {
      const vers = [...html.matchAll(/\/wp-includes\/[^"'\s]+\?ver=(\d+\.\d+(?:\.\d+)?)/g)].map((m) => m[1]);
      if (vers.length) wpVersion = mode(vers);
    }

    const core = await getJson(`${WP_API}/core/version-check/1.7/`);
    latestWp = core?.offers?.[0]?.current || null;

    if (wpVersion && latestWp) {
      const behind = cmpVer(latestWp, wpVersion) > 0;
      const branchesBehind = (() => {
        const [lm, ln] = branch(latestWp).split('.').map(Number);
        const [cm, cn] = branch(wpVersion).split('.').map(Number);
        return (lm - cm) * 10 + (ln - cn); // WP majors go x.0–x.9
      })();
      if (!behind) add('security', 'wp-core', 'WordPress version', 'pass', `Running WordPress ${wpVersion}, the latest release.`);
      else if (branchesBehind <= 0) add('security', 'wp-core', 'WordPress version', 'warn', `Running WordPress ${wpVersion}. The latest is ${latestWp}, a minor update that usually includes security fixes.`);
      else if (branchesBehind === 1) add('security', 'wp-core', 'WordPress version', 'warn', `Running WordPress ${wpVersion}. The latest is ${latestWp}.`);
      else add('security', 'wp-core', 'WordPress version', 'fail', `Running WordPress ${wpVersion}, ${branchesBehind} major releases behind the latest (${latestWp}). Old versions miss security fixes.`);
    } else if (wpVersion) {
      add('security', 'wp-core', 'WordPress version', 'info', `Running WordPress ${wpVersion}. Couldn’t look up the latest release to compare.`);
    } else {
      add('security', 'wp-core', 'WordPress version', 'info', 'The WordPress version is hidden, which is good practice. We can’t tell if it’s up to date from outside.');
    }

    // Plugins visible in asset URLs. The ?ver= value is usually the plugin version, but not always.
    const found = new Map();
    for (const m of html.matchAll(/\/wp-content\/plugins\/([a-z0-9][a-z0-9_-]*)\/[^"'\s?]*(?:\?ver=([\d.]+))?/gi)) {
      const slug = m[1].toLowerCase();
      if (!found.has(slug)) found.set(slug, []);
      if (m[2]) found.get(slug).push(m[2]);
    }
    const slugs = [...found.keys()].slice(0, 15);
    const infos = await Promise.all(slugs.map((s) =>
      getJson(`${WP_API}/plugins/info/1.2/?action=plugin_information&request[slug]=${encodeURIComponent(s)}`)));
    plugins = slugs.map((slug, i) => {
      const seen = found.get(slug).length ? mode(found.get(slug)) : null;
      const info = infos[i] && !infos[i].error ? infos[i] : null;
      const latest = info?.version || null;
      return {
        slug, name: info?.name ? decodeEntities(info.name) : slug, version: seen, latest,
        outdated: !!(seen && latest && cmpVer(latest, seen) > 0),
        lastUpdated: info?.last_updated || null,
      };
    });
    const outdated = plugins.filter((p) => p.outdated);
    if (!plugins.length) {
      add('security', 'plugins', 'Plugins', 'info', 'No plugins visible from the homepage.');
    } else if (!outdated.length) {
      add('security', 'plugins', 'Plugins', 'pass', `${plugins.length} plugin${plugins.length > 1 ? 's' : ''} visible. None look out of date from what’s exposed.`);
    } else {
      add('security', 'plugins', 'Plugins', outdated.length >= 3 ? 'fail' : 'warn',
        `${outdated.length} of ${plugins.length} visible plugins look out of date: ` +
        outdated.slice(0, 6).map((p) => `${p.name} (${p.version} → ${p.latest})`).join(', ') + '.');
    }
  } else {
    add('security', 'wp-core', 'WordPress', 'info', 'This doesn’t look like a WordPress site (or it’s well hidden), so the WordPress checks were skipped.');
  }

  const powered = h.get('x-powered-by') || '';
  const php = powered.match(/PHP\/(\d+\.\d+)(?:\.\d+)?/i);
  if (php) {
    const v = php[1];
    if (cmpVer(v, '8.1') < 0) add('security', 'php', 'Server software (PHP)', 'fail', `The server reports PHP ${v}, which no longer gets security updates.`);
    else add('security', 'php', 'Server software (PHP)', 'info', `The server reports PHP ${v}. Hiding the version is slightly safer.`);
  }

  const secHeaders = [
    ['Strict-Transport-Security', h.get('strict-transport-security')],
    ['X-Content-Type-Options', h.get('x-content-type-options')],
    ['Clickjacking protection', h.get('x-frame-options') || /frame-ancestors/i.test(h.get('content-security-policy') || '')],
  ];
  const missing = secHeaders.filter(([, v]) => !v).map(([k]) => k);
  if (!missing.length) add('security', 'headers', 'Security headers', 'pass', 'Basic security headers are in place.');
  else add('security', 'headers', 'Security headers', missing.length === 3 ? 'warn' : 'info', `Missing: ${missing.join(', ')}. Quick wins at server level.`);

  // --- Speed ---
  const ms = page.ms;
  add('speed', 'response', 'Time to load the page HTML', ms < 1200 ? 'pass' : ms < 2500 ? 'warn' : 'fail',
    `${(ms / 1000).toFixed(1)}s from our server. ${ms < 1200 ? 'Quick.' : ms < 2500 ? 'A bit slow. Caching usually helps.' : 'Slow. Visitors are waiting before anything appears.'}`);

  const scripts = (html.match(/<script[^>]+src=/gi) || []).length;
  const styles = (html.match(/<link[^>]+rel=["']?stylesheet/gi) || []).length;
  const assets = scripts + styles;
  add('speed', 'assets', 'Scripts and stylesheets', assets <= 25 ? 'pass' : assets <= 45 ? 'warn' : 'fail',
    `${scripts} scripts and ${styles} stylesheets on the homepage. ${assets > 25 ? 'Lots of separate files slow the page down, often from plugins or a page builder.' : ''}`.trim());

  const kb = Math.round(Buffer.byteLength(html) / 1024);
  if (kb > 300) add('speed', 'html-size', 'Page size (HTML only)', kb > 600 ? 'fail' : 'warn', `${kb} KB of HTML before images and scripts. Page builders often cause this.`);

  // --- Search & sharing ---
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1]?.trim();
  if (!title) add('seo', 'title', 'Page title', 'fail', 'No page title. This is what Google shows as the headline.');
  else add('seo', 'title', 'Page title', title.length > 70 || title.length < 10 ? 'warn' : 'pass',
    `“${decodeEntities(title).slice(0, 90)}” (${title.length} characters${title.length > 70 ? ', likely cut off in Google' : ''}).`);

  const desc = metaContent(html, 'name', 'description');
  add('seo', 'description', 'Meta description', desc ? 'pass' : 'warn', desc ? 'Present.' : 'Missing. Google will pick its own snippet, often badly.');

  const viewport = /<meta[^>]+name=["']viewport["']/i.test(html);
  add('seo', 'mobile', 'Mobile-friendly setup', viewport ? 'pass' : 'fail', viewport ? 'The page is set up for mobile screens.' : 'No mobile viewport tag. The site likely looks tiny on phones.');

  const ogImage = metaContent(html, 'property', 'og:image');
  add('seo', 'social', 'Social sharing preview', ogImage ? 'pass' : 'warn',
    ogImage ? 'Has a share image for LinkedIn and Facebook.' : 'No share image set. Links to the site look bare on LinkedIn and Facebook.');

  const imgs = html.match(/<img\b[^>]*>/gi) || [];
  const noAlt = imgs.filter((t) => !/\balt=/i.test(t)).length;
  if (imgs.length) add('seo', 'alt', 'Image descriptions (alt text)', noAlt === 0 ? 'pass' : noAlt <= 3 ? 'warn' : 'fail',
    noAlt ? `${noAlt} of ${imgs.length} images have no alt text. That hurts accessibility and image search.` : `All ${imgs.length} images have alt text.`);

  const h1s = (html.match(/<h1\b/gi) || []).length;
  add('seo', 'h1', 'Main heading', h1s === 1 ? 'pass' : 'warn', h1s === 1 ? 'One main heading (H1).' : h1s === 0 ? 'No main heading (H1) on the page.' : `${h1s} main headings (H1). Usually there should be one.`);

  if (final.protocol === 'https:') {
    const mixed = (html.match(/<(?:img|script|iframe|source)\b[^>]+src=["']http:\/\//gi) || []).length
      + (html.match(/<link\b[^>]+href=["']http:\/\/[^"']+\.css/gi) || []).length;
    if (mixed) add('security', 'mixed', 'Mixed content', 'warn', `${mixed} file${mixed > 1 ? 's' : ''} loaded over insecure http://, which can break the padlock.`);
  }

  // --- Upkeep & compliance ---
  const years = [...html.matchAll(/(?:©|&copy;|&#169;|copyright)\s*(?:[^<\d]{0,40})?((?:19|20)\d{2})(?:\s*[-–—]\s*((?:19|20)\d{2}))?/gi)]
    .flatMap((m) => [m[1], m[2]]).filter(Boolean).map(Number);
  const thisYear = new Date().getFullYear();
  if (years.length) {
    const y = Math.max(...years);
    add('upkeep', 'copyright', 'Footer date', y >= thisYear - 1 ? 'pass' : 'warn',
      y >= thisYear - 1 ? `Footer shows ${y}.` : `Footer still says © ${y}. Small thing, but it makes a site look abandoned.`);
  }

  const trackers = TRACKERS.filter(([, re]) => re.test(html)).map(([n]) => n);
  const consent = CONSENT_TOOLS.filter(([, re]) => re.test(html)).map(([n]) => n);
  if (!trackers.length) add('upkeep', 'consent', 'Cookie consent', 'info', 'No common tracking scripts found on the homepage.');
  else if (consent.length) add('upkeep', 'consent', 'Cookie consent', 'pass', `Uses ${trackers.join(', ')} with a consent tool (${consent.join(', ')}). Worth checking tracking waits for consent.`);
  else add('upkeep', 'consent', 'Cookie consent', 'warn', `Uses ${trackers.join(', ')} but no cookie consent tool was detected. Irish rules require consent for tracking cookies.`);

  const builder = isWP ? (BUILDERS.find(([, re]) => re.test(html)) || [])[0] || null : null;
  if (builder) add('upkeep', 'builder', 'Page builder', 'info', `Built with ${builder}. Page builders are easy to start with but often make sites heavier and harder to update.`);

  // --- Score ---
  const scored = checks.filter((c) => c.status !== 'info');
  const pts = scored.reduce((s, c) => s + (c.status === 'pass' ? 1 : c.status === 'warn' ? 0.5 : 0), 0);
  const score = scored.length ? Math.round((pts / scored.length) * 100) : 0;
  const grade = score >= 90 ? 'A' : score >= 75 ? 'B' : score >= 60 ? 'C' : score >= 45 ? 'D' : 'F';

  return json({
    ok: true,
    url: target.href, finalUrl: final.href, checkedAt: new Date().toISOString(),
    isWordPress: isWP, wpVersion, latestWp, plugins, builder,
    score, grade,
    counts: {
      fail: checks.filter((c) => c.status === 'fail').length,
      warn: checks.filter((c) => c.status === 'warn').length,
      pass: checks.filter((c) => c.status === 'pass').length,
    },
    checks,
  });
};

function metaContent(html, attr, name) {
  const re1 = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]+content=["']([^"']*)`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+${attr}=["']${name}["']`, 'i');
  const m = html.match(re1) || html.match(re2);
  return m && m[1].trim() ? m[1].trim() : null;
}
function decodeEntities(s) {
  return String(s).replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—').replace(/&#8217;|&rsquo;/g, '’')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
}
function friendlyFetchError(e, httpsErr) {
  const msg = String(e?.cause?.code || e?.name || e?.message || '');
  if (/isn’t public|Please enter/.test(e?.message || '')) return e.message;
  if (/ENOTFOUND|EAI_AGAIN/.test(msg)) return 'We couldn’t find that domain. Check the spelling?';
  if (/Timeout|AbortError/i.test(msg)) return 'The site took too long to respond.';
  if (/CERT|SSL|TLS/i.test(msg + String(httpsErr?.cause?.code || ''))) return 'The site’s security certificate has a problem.';
  return 'We couldn’t reach that site. It may be down or blocking automated checks.';
}

export const config = { path: '/api/check' };
