# Newsstand

A Google Newsstand-style scrolling news reader, hosted on GitHub Pages.

- **For you**: UNILAD, RTÉ News, WIRED, r/todayilearned and r/Futurology in one feed, with a chip for each source.
- **PS5 Reviews**: IGN's PS5 game reviews from the last 7 days, with review scores.
- **Trending**: Google Trends' top searches in Ireland and the UK over the past 24 hours, with related stories.
- **Sport**: BBC Sport football, BBC Sport F1 and RTÉ Sport. To avoid spoilers you can:
  - *Spoiler shield* (the default): headlines and photos are blurred until you tap a story.
  - *Hide*: removes the Sport tab completely.
  - *Show*: no blurring.
- **Reader view**: tap a story to read a clean text-and-images version, with adjustable text size.
- **TL;DR**: a button on every article that summarises it **on your device**:
  - *Quick* (default) picks the key sentences instantly. Nothing is downloaded.
  - *On-device AI* uses Chrome's built-in Gemini Nano summariser where it's available. Otherwise it downloads a small
    LLM (Qwen2.5 0.5B Instruct, about 0.5 GB, one time only) and runs it in the browser with
    [transformers.js](https://github.com/huggingface/transformers.js) on WebGPU, or on the CPU if WebGPU isn't available.
    The article text is never sent to a server. You can delete the downloaded model in Settings.
- Dark mode, the ability to hide individual sources, and an installable PWA ("Add to Home Screen").
- Hidden from search engines: every page carries a `noindex, nofollow` robots tag.

## How it works

GitHub Pages only serves static files, and browsers can't fetch these sites directly because of CORS, so the
fetching happens in GitHub Actions:

1. `.github/workflows/pages.yml` runs **every hour** (as well as on each push and on manual runs).
2. `scripts/fetch.mjs` reads each source's RSS feed. If a site has no usable feed, it scrapes the section page
   for article links instead. It then downloads each article and extracts the reader view with Mozilla
   Readability (the engine behind Firefox Reader View), cleaning the HTML down to text, images and links.
3. The results go to `site/data/feed.json`, `site/data/trends.json` and `site/data/articles/*.json`, and the
   `site/` folder is deployed to Pages.

If a source fails on a run, for example because it's blocking bots that day, the previous deployment's stories
for that source are kept. The Settings sheet shows which sources are currently unavailable.

Sources are configured in `scripts/sources.mjs`.

## Publishing to GitHub Pages

The workflow deploys automatically. The first time, check **Settings → Pages → Build and deployment → Source**
is set to **GitHub Actions**. (The workflow tries to turn this on itself, but some accounts need it done
by hand.) To build again immediately, go to **Actions → Build feed & deploy to GitHub Pages → Run workflow**.

## Local development

```bash
npm install
npm run fetch   # fetch every source into site/data (needs internet access)
npm run serve   # http://localhost:8080
npm test
```

## Notes

- Reddit rate-limits and often blocks cloud servers, so subreddits are fetched one at a time from their RSS
  feeds, retrying after a pause if Reddit asks to slow down. If that still fails it tries the JSON API,
  then falls back to the previous run's posts.
- UNILAD doesn't publish a documented RSS feed, so its homepage is scraped for links. A redesign of the
  site may need a tweak to `scripts/sources.mjs`.
- Copyright in the articles belongs to the publishers. This is meant for personal use. Every story links to
  the original.
