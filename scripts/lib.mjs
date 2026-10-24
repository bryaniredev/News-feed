import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';
import { JSDOM, VirtualConsole } from 'jsdom';
import { Readability } from '@mozilla/readability';

const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';

export const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

export function hashId(str) {
  return createHash('sha1').update(str).digest('hex').slice(0, 12);
}

export async function fetchText(url, { timeout = 20000, accept, ua = BROWSER_UA } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': ua,
        Accept: accept || 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IE,en-GB;q=0.9,en;q=0.8',
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { text: await res.text(), url: res.url || url };
  } finally {
    clearTimeout(timer);
  }
}

// Runs `fn` over `items` with at most `n` in flight.
export async function mapLimit(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        out[i] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

/* ---------------------------------------------------------------- feeds */

const xml = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  textNodeName: '#text',
  cdataPropName: false,
  processEntities: true,
  htmlEntities: true,
  trimValues: true,
});

const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => {
  if (v == null) return '';
  if (typeof v === 'string' || typeof v === 'number') return String(v);
  if (Array.isArray(v)) return text(v[0]);
  return text(v['#text'] ?? '');
};

export function stripHtml(html = '') {
  return decodeEntities(String(html).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

export function decodeEntities(s = '') {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function firstImgSrc(html = '') {
  const m = /<img[^>]+src=["']([^"']+)["']/i.exec(html);
  return m ? decodeEntities(m[1]) : '';
}

function itemImage(it) {
  const candidates = [
    ...arr(it['media:content']),
    ...arr(it['media:thumbnail']),
    ...arr(it['media:group']).flatMap((g) => arr(g['media:content'])),
    ...arr(it.enclosure).filter((e) => /^image\//.test(e['@type'] || '') || /\.(jpe?g|png|webp|gif)/i.test(e['@url'] || '')),
  ];
  // Prefer the widest image offered.
  const sorted = candidates
    .filter((c) => c && c['@url'] && (!c['@medium'] || c['@medium'] === 'image') && !/^video\//.test(c['@type'] || ''))
    .sort((a, b) => (+b['@width'] || 0) - (+a['@width'] || 0));
  if (sorted.length) return sorted[0]['@url'];
  return firstImgSrc(text(it['content:encoded']) || text(it.description) || text(it.content));
}

// Parses RSS 2.0 / RDF / Atom into a flat list of items.
export function parseFeed(xmlText) {
  const doc = xml.parse(xmlText);
  if (doc.rss || doc['rdf:RDF']) {
    const channel = doc.rss ? doc.rss.channel : doc['rdf:RDF'];
    const items = arr(doc.rss ? channel?.item : doc['rdf:RDF'].item);
    return items.map((it) => ({
      title: stripHtml(text(it.title)),
      url: text(it.link) || text(it.guid),
      summary: stripHtml(text(it.description)).slice(0, 400),
      published: toIso(text(it.pubDate) || text(it['dc:date'])),
      image: itemImage(it),
      author: stripHtml(text(it['dc:creator']) || text(it.author)),
      categories: arr(it.category).map(text),
      raw: it,
    }));
  }
  if (doc.feed) {
    return arr(doc.feed.entry).map((it) => {
      const links = arr(it.link);
      const alt = links.find((l) => !l['@rel'] || l['@rel'] === 'alternate') || links[0] || {};
      const content = text(it.content) || text(it.summary);
      return {
        title: stripHtml(text(it.title)),
        url: alt['@href'] || '',
        summary: stripHtml(content).slice(0, 400),
        published: toIso(text(it.published) || text(it.updated)),
        image: itemImage(it),
        author: stripHtml(text(it.author?.name)),
        categories: arr(it.category).map((c) => c['@term'] || text(c)),
        contentHtml: content,
        raw: it,
      };
    });
  }
  throw new Error('Not an RSS/Atom document');
}

export function toIso(s) {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

/* ------------------------------------------------------------- scraping */

// Finds links on a listing page that look like articles on the same site.
export function scrapeArticleLinks(html, baseUrl, { pattern, limit = 30 } = {}) {
  const base = new URL(baseUrl);
  const seen = new Map();
  const re = /<a\b[^>]*href=["']([^"'#]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = re.exec(html))) {
    let u;
    try {
      u = new URL(decodeEntities(m[1]), base);
    } catch {
      continue;
    }
    if (u.hostname.replace(/^www\./, '') !== base.hostname.replace(/^www\./, '')) continue;
    u.search = '';
    const path = u.pathname;
    const looksLikeArticle = pattern
      ? pattern.test(path)
      : (() => {
          const segs = path.split('/').filter(Boolean);
          return segs.length >= 2 && segs.slice(-2).some((s) => s.split('-').length >= 4 || /\d{6,}/.test(s));
        })();
    if (!looksLikeArticle) continue;
    const title = stripHtml(m[2]);
    const href = u.toString();
    const prev = seen.get(href);
    if (!prev || title.length > prev.length) seen.set(href, title);
  }
  return [...seen].slice(0, limit).map(([url, title]) => ({ url, title }));
}

/* ------------------------------------------------------- reader extract */

const ALLOWED_TAGS = new Set([
  'p', 'br', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code',
  'em', 'strong', 'b', 'i', 'u', 's', 'sub', 'sup', 'small', 'mark', 'a', 'img', 'figure', 'figcaption',
  'picture', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'caption', 'dl', 'dt', 'dd', 'span', 'div',
  'section', 'article', 'time', 'abbr', 'cite', 'q',
]);
const ALLOWED_ATTRS = { a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], time: ['datetime'] };

function bestSrcFromSrcset(srcset) {
  const parts = srcset.split(',').map((s) => s.trim().split(/\s+/));
  parts.sort((a, b) => (parseInt(b[1]) || 0) - (parseInt(a[1]) || 0));
  // Pick a mid-sized candidate (~1000px) rather than the very largest.
  const mid = parts.find((p) => (parseInt(p[1]) || 0) <= 1200);
  return (mid || parts[0] || [])[0];
}

// Makes lazy-loaded images real before Readability runs.
function fixLazyImages(document) {
  for (const img of document.querySelectorAll('img')) {
    const lazy =
      img.getAttribute('data-src') ||
      img.getAttribute('data-lazy-src') ||
      img.getAttribute('data-original') ||
      (img.getAttribute('data-srcset') && bestSrcFromSrcset(img.getAttribute('data-srcset')));
    const src = img.getAttribute('src') || '';
    if (lazy && (!src || src.startsWith('data:') || /placeholder|blank|spacer/i.test(src))) img.setAttribute('src', lazy);
    if ((!img.getAttribute('src') || img.getAttribute('src').startsWith('data:')) && img.getAttribute('srcset')) {
      img.setAttribute('src', bestSrcFromSrcset(img.getAttribute('srcset')));
    }
  }
  for (const pic of document.querySelectorAll('picture')) {
    const img = pic.querySelector('img');
    const source = pic.querySelector('source[srcset]');
    if (img && source && (!img.getAttribute('src') || img.getAttribute('src').startsWith('data:'))) {
      img.setAttribute('src', bestSrcFromSrcset(source.getAttribute('srcset')));
    }
  }
  for (const ns of document.querySelectorAll('noscript')) {
    if (/<img/i.test(ns.textContent) && ns.parentElement && !ns.parentElement.querySelector('img')) {
      const tmp = document.createElement('div');
      tmp.innerHTML = ns.textContent;
      ns.replaceWith(...tmp.childNodes);
    }
  }
}

function sanitize(document, root, baseUrl) {
  const walk = (el) => {
    for (const child of [...el.children]) {
      const tag = child.tagName.toLowerCase();
      if (['script', 'style', 'iframe', 'object', 'embed', 'form', 'input', 'button', 'svg', 'noscript', 'video', 'audio', 'source'].includes(tag)) {
        child.remove();
        continue;
      }
      if (!ALLOWED_TAGS.has(tag)) {
        walk(child);
        child.replaceWith(...child.childNodes);
        continue;
      }
      const keep = ALLOWED_ATTRS[tag] || [];
      for (const attr of [...child.attributes]) if (!keep.includes(attr.name)) child.removeAttribute(attr.name);
      if (tag === 'a') {
        const href = child.getAttribute('href');
        try {
          const u = new URL(href, baseUrl);
          if (!/^https?:$/.test(u.protocol)) throw 0;
          child.setAttribute('href', u.toString());
        } catch {
          child.removeAttribute('href');
        }
      }
      if (tag === 'img') {
        const src = child.getAttribute('src');
        try {
          const u = new URL(src, baseUrl);
          if (!/^https?:$/.test(u.protocol)) throw 0;
          child.setAttribute('src', u.toString());
        } catch {
          child.remove();
          continue;
        }
      }
      walk(child);
    }
  };
  walk(root);
  // Drop empty wrappers left behind.
  for (const el of [...root.querySelectorAll('p, div, span, section, figure')]) {
    if (!el.textContent.trim() && !el.querySelector('img')) el.remove();
  }
}

function meta(document, ...names) {
  for (const n of names) {
    const el = document.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = el?.getAttribute('content');
    if (v) return v.trim();
  }
  return '';
}

function jsonLd(document) {
  const out = [];
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const stack = Array.isArray(data) ? [...data] : [data];
      while (stack.length) {
        const d = stack.shift();
        if (!d || typeof d !== 'object') continue;
        out.push(d);
        if (Array.isArray(d['@graph'])) stack.push(...d['@graph']);
        if (d.itemReviewed) stack.push(d.itemReviewed);
      }
    } catch {}
  }
  return out;
}

const quietConsole = new VirtualConsole();

// Fetches a page and returns its metadata plus a cleaned reader-mode body.
export async function extractArticle(url) {
  const { text: html, url: finalUrl } = await fetchText(url);
  const dom = new JSDOM(html, { url: finalUrl, virtualConsole: quietConsole });
  const { document } = dom.window;

  const ld = jsonLd(document);
  const ldArticle = ld.find((d) => /Article|Review|BlogPosting|Report/i.test([].concat(d['@type']).join(' ')) && (d.datePublished || d.headline));
  const ldReview = ld.find((d) => [].concat(d['@type']).includes('Review'));
  const metaData = {
    title: meta(document, 'og:title', 'twitter:title') || ldArticle?.headline || document.title,
    image: meta(document, 'og:image', 'og:image:url', 'twitter:image', 'twitter:image:src'),
    summary: meta(document, 'og:description', 'description', 'twitter:description'),
    published: toIso(
      meta(document, 'article:published_time', 'datePublished', 'pubdate', 'publish-date', 'sailthru.date', 'parsely-pub-date') ||
        ldArticle?.datePublished ||
        document.querySelector('time[datetime]')?.getAttribute('datetime'),
    ),
    author: meta(document, 'author', 'article:author', 'parsely-author'),
    siteName: meta(document, 'og:site_name'),
    score: ldReview?.reviewRating?.ratingValue ?? null,
    scoreMax: ldReview?.reviewRating?.bestRating ?? null,
    platforms: [].concat(ldReview?.itemReviewed?.gamePlatform || [], ldReview?.itemReviewed?.operatingSystem || []).map(String),
    pageText: '',
  };

  fixLazyImages(document);
  const article = new Readability(document, { charThreshold: 300, keepClasses: false }).parse();
  if (!article || !article.content) return { ...metaData, contentHtml: '', textContent: '' };

  const frag = new JSDOM(`<article>${article.content}</article>`, { virtualConsole: quietConsole }).window.document;
  const root = frag.querySelector('article');
  sanitize(frag, root, finalUrl);

  // Drop the lead image from the body if it duplicates the hero image.
  const firstImg = root.querySelector('img');
  if (firstImg && metaData.image && sameImage(firstImg.getAttribute('src'), metaData.image)) {
    (firstImg.closest('figure') || firstImg).remove();
  }

  const textContent = root.textContent.replace(/\s+/g, ' ').trim();
  return {
    ...metaData,
    title: metaData.title || article.title,
    author: metaData.author || article.byline || '',
    summary: metaData.summary || article.excerpt || '',
    contentHtml: root.innerHTML.trim(),
    textContent,
    readingMinutes: Math.max(1, Math.round(textContent.split(' ').length / 230)),
  };
}

function sameImage(a = '', b = '') {
  const key = (s) => {
    try {
      const u = new URL(s);
      return u.pathname.split('/').pop().replace(/\.(jpe?g|png|webp|gif|avif)$/i, '');
    } catch {
      return s;
    }
  };
  return key(a) && key(a) === key(b);
}
