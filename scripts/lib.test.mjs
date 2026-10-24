import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { extractArticle, parseFeed, scrapeArticleLinks } from './lib.mjs';
import { quickSummary } from '../site/tldr.js';

test('parses RSS 2.0 with media images', () => {
  const items = parseFeed(`<?xml version="1.0"?>
    <rss version="2.0" xmlns:media="http://search.yahoo.com/mrss/" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel>
      <item><title><![CDATA[Big &amp; bold news]]></title><link>https://example.com/a/one-two-three-four</link>
        <description><![CDATA[<p>Hello <b>world</b></p>]]></description><pubDate>Fri, 23 Oct 2026 10:00:00 GMT</pubDate>
        <media:content url="https://img.example.com/small.jpg" width="100" medium="image"/>
        <media:content url="https://img.example.com/large.jpg" width="1200" medium="image"/>
        <dc:creator>Jane</dc:creator></item>
      <item><title>Second</title><link>https://example.com/b</link><enclosure url="https://img.example.com/e.png" type="image/png"/></item>
    </channel></rss>`);
  assert.equal(items.length, 2);
  assert.equal(items[0].title, 'Big & bold news');
  assert.equal(items[0].summary, 'Hello world');
  assert.equal(items[0].image, 'https://img.example.com/large.jpg');
  assert.equal(items[0].published, '2026-10-23T10:00:00.000Z');
  assert.equal(items[0].author, 'Jane');
  assert.equal(items[1].image, 'https://img.example.com/e.png');
});

test('parses Atom (Reddit style)', () => {
  const items = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom">
    <entry><title>TIL something</title><link href="https://www.reddit.com/r/todayilearned/comments/x/til/"/>
      <updated>2026-10-24T09:00:00+00:00</updated><author><name>/u/bob</name></author>
      <content type="html">&lt;a href="https://en.wikipedia.org/wiki/Thing"&gt;[link]&lt;/a&gt;</content></entry></feed>`);
  assert.equal(items.length, 1);
  assert.equal(items[0].url, 'https://www.reddit.com/r/todayilearned/comments/x/til/');
  assert.match(items[0].contentHtml, /\[link\]/);
});

test('parses Google Trends RSS extensions', () => {
  const items = parseFeed(`<rss xmlns:ht="https://trends.google.com/trending/rss" version="2.0"><channel>
    <item><title>storm warning</title><ht:approx_traffic>20000+</ht:approx_traffic><pubDate>Sat, 24 Oct 2026 08:00:00 +0100</pubDate>
      <ht:picture>https://t0.gstatic.com/x</ht:picture>
      <ht:news_item><ht:news_item_title>Met Éireann warns</ht:news_item_title><ht:news_item_url>https://x.ie/a</ht:news_item_url><ht:news_item_source>RTÉ</ht:news_item_source></ht:news_item>
      <ht:news_item><ht:news_item_title>Second</ht:news_item_title><ht:news_item_url>https://y.ie/b</ht:news_item_url><ht:news_item_source>Indo</ht:news_item_source></ht:news_item>
    </item></channel></rss>`);
  assert.equal(items[0].raw['ht:approx_traffic'], '20000+');
  assert.equal(items[0].raw['ht:news_item'].length, 2);
});

test('scrapes article-like links from a listing page', () => {
  const html = `
    <a href="/news/world/man-does-something-very-unusual-today-20261024">Man does something <b>very</b> unusual</a>
    <a href="/about">About</a>
    <a href="https://other.com/a/b-c-d-e-f">offsite</a>
    <a href="/football/premier-league/2026-27/arsenal-win_sto123456/story.shtml">Arsenal win</a>`;
  const links = scrapeArticleLinks(html, 'https://www.example.com/');
  assert.deepEqual(
    links.map((l) => l.url),
    ['https://www.example.com/news/world/man-does-something-very-unusual-today-20261024', 'https://www.example.com/football/premier-league/2026-27/arsenal-win_sto123456/story.shtml'],
  );
  assert.equal(links[0].title, 'Man does something very unusual');
  const tnt = scrapeArticleLinks(html, 'https://www.example.com/', { pattern: /_sto\d+\/story\.shtml$/ });
  assert.equal(tnt.length, 1);
});

test('extracts a clean reader view', async () => {
  const para = (n) => `<p>Paragraph ${n} with plenty of words so that Readability treats this as real article content worth keeping around for readers.</p>`;
  const page = `<!doctype html><html><head><title>Site</title>
    <meta property="og:title" content="The headline">
    <meta property="og:image" content="https://cdn.example.com/hero.jpg">
    <meta property="article:published_time" content="2026-10-22T12:00:00Z">
    <script type="application/ld+json">{"@type":"Review","reviewRating":{"ratingValue":8,"bestRating":10},"itemReviewed":{"@type":"VideoGame","gamePlatform":["PlayStation 5"]}}</script>
    </head><body><nav><a href="/">Home</a></nav><article>
    <h1>The headline</h1>${para(1)}
    <figure><img data-src="/images/inline.jpg" src="data:image/gif;base64,R0lGOD"><figcaption>Caption</figcaption></figure>
    ${para(2)}<p onclick="alert(1)">Click <a href="javascript:alert(1)">bad</a> <a href="/rel">good</a></p>
    <script>alert(1)</script>${para(3)}${para(4)}${para(5)}</article><footer>Footer</footer></body></html>`;
  const server = createServer((req, res) => res.writeHead(200, { 'Content-Type': 'text/html' }).end(page));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const a = await extractArticle(`${base}/story`);
    assert.equal(a.title, 'The headline');
    assert.equal(a.image, 'https://cdn.example.com/hero.jpg');
    assert.equal(a.published, '2026-10-22T12:00:00.000Z');
    assert.equal(a.score, 8);
    assert.deepEqual(a.platforms, ['PlayStation 5']);
    assert.match(a.contentHtml, new RegExp(`<img src="${base}/images/inline.jpg"`));
    assert.match(a.contentHtml, new RegExp(`href="${base}/rel"`));
    assert.doesNotMatch(a.contentHtml, /script|onclick|javascript:|Footer/);
    assert.ok(a.readingMinutes >= 1);
  } finally {
    server.close();
  }
});

test('quick summary picks a few key sentences in order', () => {
  const text =
    'The government announced a new housing plan for Dublin on Tuesday. ' +
    'The housing plan will deliver ten thousand homes across Dublin by 2030. ' +
    'Weather was mild across the country with light showers expected. ' +
    'Critics said the housing plan lacks funding details for Dublin councils. ' +
    'A local football club celebrated its centenary with a parade through the town. ' +
    'Ministers will publish the full housing plan for Dublin next month after consultation.';
  const out = quickSummary(text, 'Dublin housing plan announced').split('\n');
  assert.equal(out.length, 3);
  assert.ok(out.every((s) => /housing|Dublin/.test(s)));
});
