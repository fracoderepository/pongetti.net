#!/usr/bin/env node
// Build the feed: enrich posts with link metadata (once), paginate into feed/, write RSS.
// Usage: node scripts/build-feed.mjs        (run from repo root; Node 20+, no dependencies)

import { readdir, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const POSTS_DIR = path.join(ROOT, 'posts');
const FEED_DIR = path.join(ROOT, 'feed');
const PER_PAGE = 20;
const SITE = 'https://www.pongetti.net';
const FETCH_TIMEOUT_MS = 10000;
const UA = 'Mozilla/5.0 (compatible; pongetti.net feed bot; +https://www.pongetti.net)';

// ---------- helpers ----------
const decodeEntities = s => s
  .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(parseInt(e[1] === 'x' ? e.slice(2) : e.slice(1), e[1] === 'x' ? 16 : 10));
    return { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' }[e] ?? m;
  });
const clean = s => decodeEntities(String(s ?? '')).replace(/\s+/g, ' ').trim();
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);
const hostOf = u => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };

function metaTag(html, ...names) {
  for (const name of names) {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>`, 'i');
    const tag = html.match(re)?.[0];
    if (!tag) continue;
    const content = tag.match(/content=["']([^"']*)["']/i)?.[1];
    if (content) return clean(content);
  }
  return '';
}

async function fetchMeta(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const r = await fetch(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'User-Agent': UA, Accept: 'text/html,*/*;q=0.8', 'Accept-Language': 'en' } });
    const type = r.headers.get('content-type') || '';
    const finalUrl = r.url || url;
    if (!r.ok || !/html|xml/.test(type)) return { title: '', description: '', image: '', site: hostOf(finalUrl), finalUrl, status: r.status };
    // read at most ~512KB
    const reader = r.body.getReader(); const chunks = []; let got = 0;
    while (got < 512 * 1024) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); got += value.length; }
    reader.cancel().catch(() => {});
    const html = new TextDecoder('utf-8', { fatal: false }).decode(Buffer.concat(chunks.map(c => Buffer.from(c))));
    const head = html.slice(0, 300 * 1024);
    let title = metaTag(head, 'og:title', 'twitter:title') || clean(head.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '');
    let description = metaTag(head, 'og:description', 'twitter:description', 'description');
    let image = metaTag(head, 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src');
    const site = metaTag(head, 'og:site_name') || hostOf(finalUrl);
    if (image) { try { image = new URL(image, finalUrl).href; } catch { image = ''; } }
    if (image && !/^https:/.test(image)) image = ''; // avoid mixed content
    return { title: clip(title, 140), description: clip(description, 220), image, site: clip(site, 60), finalUrl, status: r.status };
  } catch (e) {
    return { title: '', description: '', image: '', site: hostOf(url), finalUrl: url, error: e.name === 'AbortError' ? 'timeout' : e.message };
  } finally { clearTimeout(timer); }
}

// ---------- main ----------
async function main() {
  if (!existsSync(POSTS_DIR)) await mkdir(POSTS_DIR, { recursive: true });
  const files = (await readdir(POSTS_DIR)).filter(f => f.endsWith('.json')).sort();
  const posts = [];
  let enriched = 0;

  for (const f of files) {
    const p = path.join(POSTS_DIR, f);
    let post;
    try { post = JSON.parse(await readFile(p, 'utf8')); } catch (e) { console.warn(`skip ${f}: ${e.message}`); continue; }
    post.id ||= f.replace(/\.json$/, '');
    post.created ||= new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    post.note = String(post.note ?? '').trim();
    // Fetch metadata once; a failed fetch is retried on up to 3 later builds.
    const attempts = post.meta?.attempts ?? 0;
    const needsFetch = post.url && !post.skipMeta && (!post.meta || (post.meta.failed && attempts < 3));
    if (needsFetch) {
      console.log(`fetch ${post.url}`);
      const m = await fetchMeta(post.url);
      const failed = !!m.error || !(m.status >= 200 && m.status < 300);
      post.meta = { title: m.title, description: m.description, image: m.image, site: m.site, fetched: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z') };
      if (failed) { post.meta.failed = true; post.meta.attempts = attempts + 1; post.meta.error = m.error || `HTTP ${m.status}`; }
      await writeFile(p, JSON.stringify(post, null, 2) + '\n');
      enriched++;
    }
    posts.push(post);
  }

  posts.sort((a, b) => (a.created < b.created ? 1 : a.created > b.created ? -1 : 0));

  // paginate
  await rm(FEED_DIR, { recursive: true, force: true });
  await mkdir(FEED_DIR, { recursive: true });
  const pages = Math.ceil(posts.length / PER_PAGE);
  for (let i = 0; i < pages; i++) {
    const slice = posts.slice(i * PER_PAGE, (i + 1) * PER_PAGE).map(({ id, url, note, created, meta }) => ({ id, url, note, created, meta }));
    await writeFile(path.join(FEED_DIR, `page-${i + 1}.json`), JSON.stringify(slice));
  }
  await writeFile(path.join(FEED_DIR, 'index.json'), JSON.stringify({ pages, total: posts.length, perPage: PER_PAGE, built: new Date().toISOString() }));

  // RSS
  const x = s => String(s ?? '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const items = posts.slice(0, 50).map(p => {
    const t = p.meta?.title || p.note.split('\n')[0] || p.url || p.id;
    const desc = [p.note, p.meta?.description].filter(Boolean).map(x).join('<br><br>');
    return `  <item>
    <title>${x(clip(t, 120))}</title>
    <link>${x(p.url || SITE + '/#' + p.id)}</link>
    <guid isPermaLink="false">${x(p.id)}</guid>
    <pubDate>${new Date(p.created).toUTCString()}</pubDate>
    <description><![CDATA[${desc.replace(/]]>/g, ']]&gt;')}]]></description>
  </item>`;
  }).join('\n');
  const rss = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
<channel>
  <title>pongetti.net</title>
  <link>${SITE}/</link>
  <atom:link href="${SITE}/feed.xml" rel="self" type="application/rss+xml"/>
  <description>Links worth a minute of your time.</description>
  <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
${items}
</channel>
</rss>
`;
  await writeFile(path.join(ROOT, 'feed.xml'), rss);

  console.log(`${posts.length} posts, ${pages} page(s), ${enriched} newly enriched.`);
}

main().catch(e => { console.error(e); process.exit(1); });
