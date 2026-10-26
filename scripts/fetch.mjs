// Fetches every source, extracts reader-mode article bodies and writes the
// static JSON that the site reads from site/data/.
//
//   node scripts/fetch.mjs
//
// Env:
//   OUT_DIR            output directory (default: site/data)
//   PREVIOUS_SITE_URL  live site URL; a source that fails this run keeps the
//                      items it had in the previous deployment.

import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NEWS_SOURCES, REVIEW_SOURCES, SPORT_SOURCES, TREND_REGIONS } from './sources.mjs';
import { extractArticle, fetchText, hashId, log, mapLimit, parseFeed, scrapeArticleLinks, stripHtml } from './lib.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.resolve(process.env.OUT_DIR || path.join(ROOT, 'site/data'));
const ARTICLE_DIR = path.join(OUT_DIR, 'articles');
const PREVIOUS = (process.env.PREVIOUS_SITE_URL || '').replace(/\/$/, '');
const DAY = 864e5;
const EXTRACT_CONCURRENCY = 6;

/* --------------------------------------------------------- list sources */

async function itemsFromFeeds(feeds = [], limit) {
  const errors = [];
  for (const feedUrl of feeds) {
    try {
      const { text } = await fetchText(feedUrl, { accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml;q=0.9, */*;q=0.5' });
      const items = parseFeed(text).filter((i) => i.url && i.title);
      if (items.length) {
        log(`  feed ok: ${feedUrl} (${items.length})`);
        return items.slice(0, limit);
      }
      errors.push(`${feedUrl}: empty`);
    } catch (err) {
      errors.push(`${feedUrl}: ${err.message}`);
    }
  }
  if (errors.length) log(`  feeds failed: ${errors.join(' | ')}`);
  return [];
}

async function itemsFromPage(src, limit) {
  const { text, url } = await fetchText(src.page);
  const links = scrapeArticleLinks(text, url, { pattern: src.linkPattern, limit });
  log(`  scraped ${links.length} links from ${src.page}`);
  return links.map((l) => ({ ...l, summary: '', published: null, image: '' }));
}

async function listGeneric(src) {
  let items = await itemsFromFeeds(src.feeds, src.limit);
  if (!items.length && src.page) {
    try {
      items = await itemsFromPage(src, src.limit);
    } catch (err) {
      if (!src.fallbackFeeds) throw err;
      log(`  page failed: ${src.page}: ${err.message}`);
    }
  }
  if (!items.length && src.fallbackFeeds) {
    // Google News titles end in " - Publisher".
    items = (await itemsFromFeeds(src.fallbackFeeds, src.limit)).map((i) => ({ ...i, title: i.title.replace(/\s+-\s+[^-]+$/, ''), summary: '' }));
  }
  return items;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REDDIT_UA = 'web:news-feed-scroller:1.0 (personal news reader)';

// Reddit rate-limits hard, so subreddits are fetched one at a time.
let redditQueue = Promise.resolve();
function listReddit(src) {
  const run = redditQueue.then(() => listRedditNow(src));
  redditQueue = run.catch(() => {}).then(() => sleep(3000));
  return run;
}

async function redditRss(src) {
  const urls = [`https://www.reddit.com/r/${src.subreddit}/.rss`, `https://old.reddit.com/r/${src.subreddit}/.rss`];
  for (const u of urls) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const { text } = await fetchText(u, { ua: REDDIT_UA, accept: 'application/atom+xml, application/xml;q=0.9' });
        const items = parseFeed(text).filter((i) => i.url && i.title);
        log(`  reddit rss ok: ${u} (${items.length})`);
        return items;
      } catch (err) {
        log(`  reddit rss failed: ${u}: ${err.message}`);
        if (!/HTTP 429/.test(err.message) || attempt === 2) break;
        await sleep(15000 * (attempt + 1));
      }
    }
  }
  return [];
}

async function listRedditNow(src) {
  const rssItems = await redditRss(src);
  if (rssItems.length) {
    return rssItems
      .filter((i) => !/^\s*\[?(meta|mod post)/i.test(i.title))
      .slice(0, src.limit)
      .map((i) => {
        const linkMatch = /<a href="([^"]+)">\[link\]<\/a>/.exec(i.contentHtml || '');
        return { ...i, summary: '', link: linkMatch ? linkMatch[1].replace(/&amp;/g, '&') : '' };
      });
  }
  // The JSON API has scores and comment counts but usually refuses cloud servers.
  const jsonUrls = [
    `https://www.reddit.com/r/${src.subreddit}/hot.json?limit=${src.limit + 5}&raw_json=1`,
    `https://old.reddit.com/r/${src.subreddit}/hot.json?limit=${src.limit + 5}&raw_json=1`,
  ];
  for (const u of jsonUrls) {
    try {
      const { text } = await fetchText(u, { ua: REDDIT_UA, accept: 'application/json' });
      const posts = JSON.parse(text).data.children.map((c) => c.data).filter((p) => !p.stickied);
      log(`  reddit json ok: ${u} (${posts.length})`);
      return posts.slice(0, src.limit).map((p) => ({
        title: p.title,
        url: `https://www.reddit.com${p.permalink}`,
        link: p.url_overridden_by_dest || p.url,
        summary: p.selftext ? p.selftext.slice(0, 400) : '',
        published: new Date(p.created_utc * 1000).toISOString(),
        image: p.preview?.images?.[0]?.source?.url || (/^https?:/.test(p.thumbnail) ? p.thumbnail : ''),
        author: `u/${p.author}`,
        score: p.score,
        comments: p.num_comments,
      }));
    } catch (err) {
      log(`  reddit json failed: ${u}: ${err.message}`);
    }
  }
  return [];
}

/* -------------------------------------------------- enrich with reader */

function isExtractable(url) {
  return /^https?:/.test(url || '') && !/\.(jpe?g|png|gif|gifv|webp|mp4|pdf)(\?|$)/i.test(url) && !/(news\.google\.com|reddit\.com|redd\.it|youtube\.com|youtu\.be|imgur\.com|twitter\.com|x\.com)/i.test(url);
}

async function enrich(src, rawItems) {
  return mapLimit(rawItems, EXTRACT_CONCURRENCY, async (raw) => {
    const item = {
      id: hashId(raw.url),
      source: src.id,
      section: src.section,
      title: raw.title,
      url: raw.url,
      summary: raw.summary || '',
      image: raw.image || '',
      published: raw.published || null,
      author: raw.author || '',
    };
    if (raw.score != null) item.score = raw.score;
    if (raw.comments != null) item.comments = raw.comments;
    if (raw.link) item.link = raw.link;
    if (src.kind === 'reddit') item.reddit = true;

    const target = src.kind === 'reddit' ? raw.link : raw.url;
    let article = null;
    if (isExtractable(target)) {
      try {
        article = await extractArticle(target);
      } catch (err) {
        log(`    extract failed ${target}: ${err.message}`);
      }
    }
    if (article) {
      if (src.kind !== 'reddit') {
        item.title = item.title || article.title;
        item.image = item.image || article.image;
        item.summary = item.summary || article.summary;
        item.published = item.published || article.published;
        item.author = item.author || article.author;
      } else {
        item.image = item.image || article.image;
        item.sourceTitle = article.title;
        item.sourceSite = article.siteName || new URL(target).hostname.replace(/^www\./, '');
      }
      if (article.score != null) {
        item.score = Number(article.score);
        item.scoreMax = Number(article.scoreMax) || 10;
      }
      if (article.platforms?.length) item.platforms = article.platforms;
      if (article.contentHtml) {
        item.hasContent = true;
        item.readingMinutes = article.readingMinutes;
        item._content = article.contentHtml;
        item._text = article.textContent;
      }
      // Keep a page-text sample for filters like "is this a PS5 review?".
      item._pageText = (article.textContent || '').slice(0, 4000);
    }
    item.summary = stripHtml(item.summary).slice(0, 300);
    return item;
  }).then((items) => items.filter(Boolean));
}

/* ------------------------------------------------------- IGN reviews */

async function listIgnReviews(src) {
  const cutoff = Date.now() - src.maxAgeDays * DAY;
  let raw = [];
  try {
    raw = await itemsFromPage({ ...src, linkPattern: /^\/articles\/[^/]*review[^/]*$/ }, src.limit);
  } catch (err) {
    log(`  IGN page failed: ${err.message}`);
  }
  const fromPage = raw.length > 0;
  if (!fromPage) {
    const feedItems = await itemsFromFeeds(src.feeds, 80);
    raw = feedItems.filter((i) => /review/i.test(i.title) && /\/articles\//.test(i.url));
  }
  // Drop anything the feed already dates as too old before fetching it.
  raw = raw.filter((i) => !i.published || Date.parse(i.published) >= cutoff);
  const items = await enrich(src, raw);
  return items.filter((i) => {
    if (!i.published || Date.parse(i.published) < cutoff) return false;
    if (fromPage) return true;
    const platforms = (i.platforms || []).join(' ');
    return /ps5|playstation 5/i.test(platforms) || /\bPS5\b|PlayStation 5/.test(i._pageText || '');
  });
}

/* -------------------------------------------------------------- trends */

async function fetchTrends(region) {
  const { text } = await fetchText(`https://trends.google.com/trending/rss?geo=${region.id}`, { accept: 'application/rss+xml, application/xml' });
  const items = parseFeed(text);
  const cutoff = Date.now() - DAY;
  const trends = items
    .map((i) => {
      const r = i.raw;
      const traffic = String(r['ht:approx_traffic'] ?? '').trim();
      const news = [].concat(r['ht:news_item'] || []).map((n) => ({
        title: stripHtml(String(n['ht:news_item_title'] ?? '')),
        url: String(n['ht:news_item_url'] ?? ''),
        source: String(n['ht:news_item_source'] ?? ''),
        image: String(n['ht:news_item_picture'] ?? ''),
      }));
      return {
        title: i.title,
        traffic,
        trafficNum: Number(traffic.replace(/[^\d]/g, '')) * (/k/i.test(traffic) ? 1e3 : /m/i.test(traffic) ? 1e6 : 1) || 0,
        published: i.published,
        image: String(r['ht:picture'] ?? '') || news.find((n) => n.image)?.image || '',
        imageSource: String(r['ht:picture_source'] ?? ''),
        news,
        search: `https://www.google.com/search?q=${encodeURIComponent(i.title)}`,
      };
    })
    .filter((t) => !t.published || Date.parse(t.published) >= cutoff)
    .sort((a, b) => b.trafficNum - a.trafficNum);
  return trends;
}

/* ---------------------------------------------------- previous deploy */

let previousFeed;
async function previousItems(sourceId) {
  if (!PREVIOUS) return [];
  if (previousFeed === undefined) {
    try {
      previousFeed = JSON.parse((await fetchText(`${PREVIOUS}/data/feed.json`, { accept: 'application/json' })).text);
    } catch {
      previousFeed = null;
    }
  }
  const items = previousFeed?.items?.filter((i) => i.source === sourceId) || [];
  // Bring their article bodies across too.
  await mapLimit(items, EXTRACT_CONCURRENCY, async (i) => {
    if (!i.hasContent) return;
    try {
      const art = JSON.parse((await fetchText(`${PREVIOUS}/data/articles/${i.id}.json`, { accept: 'application/json' })).text);
      i._content = art.contentHtml;
      i._text = art.textContent;
    } catch {
      i.hasContent = false;
    }
  });
  return items;
}

/* ------------------------------------------------------------------ main */

async function runSource(src) {
  log(`▶ ${src.name}`);
  const started = Date.now();
  let items = [];
  let error = null;
  try {
    if (src.kind === 'reddit') items = await enrich(src, await listReddit(src));
    else if (src.kind === 'ign-reviews') items = await listIgnReviews(src);
    else items = await enrich(src, await listGeneric(src));
  } catch (err) {
    error = err.message;
  }
  let stale = false;
  if (!items.length && src.kind !== 'ign-reviews') {
    const prev = await previousItems(src.id);
    if (prev.length) {
      items = prev;
      stale = true;
    }
  }
  if (!items.length && !error) error = 'No items found';
  log(`  ${src.name}: ${items.length} items${stale ? ' (kept from previous run)' : ''}${error ? `, error: ${error}` : ''} in ${((Date.now() - started) / 1000).toFixed(1)}s`);
  return {
    meta: { id: src.id, name: src.name, section: src.section, color: src.color, page: src.page, count: items.length, ok: items.length > 0, stale, error: items.length ? null : error },
    items,
  };
}

async function main() {
  await rm(OUT_DIR, { recursive: true, force: true });
  await mkdir(ARTICLE_DIR, { recursive: true });

  const sources = [...NEWS_SOURCES, ...REVIEW_SOURCES, ...SPORT_SOURCES];
  const results = [];
  // A couple of sources at a time; each one fans out its own article fetches.
  await mapLimit(sources, 3, async (src, i) => {
    results[i] = await runSource(src);
  });

  const seen = new Set();
  const items = [];
  for (const r of results) {
    for (const item of r.items) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      if (item._content) {
        await writeFile(
          path.join(ARTICLE_DIR, `${item.id}.json`),
          JSON.stringify({ id: item.id, title: item.title, url: item.url, contentHtml: item._content, textContent: item._text }),
        );
      }
      delete item._content;
      delete item._text;
      delete item._pageText;
      items.push(item);
    }
  }

  const trends = { generatedAt: new Date().toISOString(), regions: {} };
  for (const region of TREND_REGIONS) {
    try {
      const list = await fetchTrends(region);
      trends.regions[region.id] = { name: region.name, page: region.page, ok: true, items: list };
      log(`▶ Trends ${region.id}: ${list.length}`);
    } catch (err) {
      let prev = null;
      if (PREVIOUS) {
        try {
          prev = JSON.parse((await fetchText(`${PREVIOUS}/data/trends.json`, { accept: 'application/json' })).text).regions?.[region.id];
        } catch {}
      }
      trends.regions[region.id] = prev?.items?.length
        ? { ...prev, stale: true }
        : { name: region.name, page: region.page, ok: false, error: err.message, items: [] };
      log(`▶ Trends ${region.id} failed: ${err.message}`);
    }
  }

  const feed = { generatedAt: new Date().toISOString(), sources: results.map((r) => r.meta), items };
  await writeFile(path.join(OUT_DIR, 'feed.json'), JSON.stringify(feed));
  await writeFile(path.join(OUT_DIR, 'trends.json'), JSON.stringify(trends));
  log(`Done: ${items.length} items, ${items.filter((i) => i.hasContent).length} with reader content.`);
  for (const s of feed.sources) log(`  ${s.ok ? '✓' : '✗'} ${s.name}: ${s.count}${s.error ? ` (${s.error})` : ''}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
