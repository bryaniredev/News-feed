const DATA_URL = 'data/feed.json';
const TRENDS_URL = 'data/trends.json';
const PAGE_SIZE = 24;

const TABS = [
  { id: 'news', label: 'For you', section: 'news' },
  { id: 'reviews', label: 'PS5 Reviews', section: 'reviews' },
  { id: 'trending', label: 'Trending' },
  { id: 'sports', label: 'Sport', section: 'sports' },
];

/* ------------------------------------------------------------ settings */

const DEFAULTS = { sport: 'shield', hiddenSources: [], tldr: 'quick', theme: 'auto', font: 19, region: 'IE' };
const settings = (() => {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem('newsstand.settings') || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
})();
function saveSettings() {
  try {
    localStorage.setItem('newsstand.settings', JSON.stringify(settings));
  } catch {}
}

/* -------------------------------------------------------------- state */

const state = {
  feed: null,
  trends: null,
  tab: 'news',
  source: 'all',
  list: [],
  rendered: 0,
  revealed: new Set(),
  openTrend: null,
};
const $ = (sel, el = document) => el.querySelector(sel);
const view = $('#view');
const chips = $('#chips');

/* -------------------------------------------------------------- utils */

const esc = (s = '') => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function timeAgo(iso) {
  if (!iso) return '';
  const diff = (Date.now() - Date.parse(iso)) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

function fmtDate(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function compact(n) {
  return n >= 1e3 ? `${(n / 1e3).toFixed(n >= 1e4 ? 0 : 1)}k` : String(n);
}

function host(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

function sourceById(id) {
  return state.feed?.sources.find((s) => s.id === id) || { id, name: id, color: '#888' };
}

function initials(name) {
  const clean = name.replace(/^r\//, '').replace(/[^\p{L}\p{N} ]/gu, '');
  const words = clean.split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : clean.slice(0, 2)).toUpperCase();
}

function badge(src) {
  return `<span class="src-badge" style="background:${esc(src.color)}">${esc(initials(src.name))}</span>`;
}

function scoreClass(score, max = 10) {
  const s = (score / max) * 10;
  return s >= 9 ? 's-great' : s >= 7 ? 's-good' : s >= 5 ? 's-ok' : 's-bad';
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function applyTheme() {
  if (settings.theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', settings.theme);
  document.documentElement.style.setProperty('--reader-size', `${settings.font}px`);
}

/* --------------------------------------------------------------- data */

async function loadData(force = false) {
  const bust = force ? `?t=${Date.now()}` : '';
  const [feed, trends] = await Promise.all([
    fetch(DATA_URL + bust, { cache: force ? 'no-store' : 'default' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(TRENDS_URL + bust, { cache: force ? 'no-store' : 'default' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  state.feed = feed || { generatedAt: null, sources: [], items: [] };
  state.trends = trends || { regions: {} };
  $('#updated').textContent = feed?.generatedAt ? `Updated ${timeAgo(feed.generatedAt)}` : '';
}

/* --------------------------------------------------------------- tabs */

function visibleTabs() {
  return TABS.filter((t) => !(t.id === 'sports' && settings.sport === 'hide'));
}

function renderTabs() {
  $('#tabs').innerHTML = visibleTabs()
    .map(
      (t) => `<button class="tab" role="tab" data-tab="${t.id}" aria-selected="${t.id === state.tab}">${t.label}${
        t.id === 'sports' && settings.sport === 'shield'
          ? ' <svg viewBox="0 0 24 24" aria-label="Spoiler shield on"><path d="M12 1 3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4z"/></svg>'
          : ''
      }</button>`,
    )
    .join('');
}

function renderChips() {
  const tab = TABS.find((t) => t.id === state.tab);
  if (!tab.section || !state.feed) {
    chips.innerHTML = '';
    return;
  }
  const sources = state.feed.sources.filter((s) => s.section === tab.section && !settings.hiddenSources.includes(s.id));
  if (sources.length < 2) {
    chips.innerHTML = '';
    return;
  }
  chips.innerHTML = [
    `<button class="chip" data-source="all" aria-pressed="${state.source === 'all'}">All</button>`,
    ...sources.map(
      (s) =>
        `<button class="chip${s.ok ? '' : ' warn'}" data-source="${s.id}" aria-pressed="${state.source === s.id}" title="${s.ok ? '' : esc(s.error || 'Unavailable')}"><span class="dot" style="background:${esc(s.color)}"></span>${esc(s.name)}</button>`,
    ),
  ].join('');
}

/* --------------------------------------------------------------- feed */

function itemsFor(section, source) {
  const hidden = new Set(settings.hiddenSources);
  return state.feed.items
    .filter((i) => i.section === section && !hidden.has(i.source) && (source === 'all' || i.source === source))
    .map((i, idx) => ({ i, idx }))
    .sort((a, b) => (Date.parse(b.i.published) || 0) - (Date.parse(a.i.published) || 0) || a.idx - b.idx)
    .map(({ i }) => i);
}

function cardHtml(item, index) {
  const src = sourceById(item.source);
  const hero = index % 9 === 0 && item.image;
  const shielded = item.section === 'sports' && settings.sport === 'shield' && !state.revealed.has(item.id);
  const reddit = item.reddit || item.source === 'til';
  const classes = ['card', hero && 'hero', !item.image && 'no-img', shielded && 'shielded', reddit && 'reddit'].filter(Boolean).join(' ');
  const meta = [];
  if (item.published) meta.push(timeAgo(item.published));
  if (reddit) {
    if (item.score != null) meta.push(`▲ ${compact(item.score)}`);
    if (item.comments != null) meta.push(`${compact(item.comments)} comments`);
    if (item.link && host(item.link)) meta.push(host(item.link));
  } else {
    if (item.readingMinutes) meta.push(`${item.readingMinutes} min read`);
  }
  if (item.platforms?.length && item.section === 'reviews') meta.push(item.platforms.slice(0, 3).join(', '));
  const score =
    item.section === 'reviews' && item.score != null
      ? `<span class="score ${scoreClass(item.score, item.scoreMax)}" title="IGN score">${esc(item.score)}</span>`
      : '';
  const title = item.source === 'til' ? item.title.replace(/^TIL:?\s*(that\s+)?/i, (m, that) => (that ? 'TIL that ' : 'TIL ')) : item.title;
  return `<article class="${classes}" tabindex="0" data-id="${item.id}">
    <div class="card-body">
      <div class="card-src">${badge(src)}<span>${esc(src.name)}</span>${hero ? '' : score}</div>
      <h3 class="card-title">${esc(title)}</h3>
      ${hero && item.summary ? `<p class="card-sum">${esc(item.summary)}</p>` : ''}
      <div class="card-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
    </div>
    ${item.image ? `<img class="card-thumb" src="${esc(item.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" />` : ''}
    ${hero ? score : ''}
  </article>`;
}

function renderMore() {
  const feedEl = $('.feed', view);
  if (!feedEl || state.rendered >= state.list.length) return;
  const next = state.list.slice(state.rendered, state.rendered + PAGE_SIZE);
  feedEl.insertAdjacentHTML('beforeend', next.map((item, k) => cardHtml(item, state.rendered + k)).join(''));
  state.rendered += next.length;
}

function sectionHeader(tab) {
  if (tab.id === 'reviews') {
    return `<h2 class="section-title">PS5 reviews</h2><p class="section-sub">IGN reviews of PS5 games from the last 7 days.</p>`;
  }
  if (tab.id === 'sports') {
    const shield = settings.sport === 'shield';
    return `<h2 class="section-title">Sport</h2><p class="section-sub">${
      shield ? 'Spoiler shield is on — tap a story once to reveal it.' : 'BBC Sport football and F1, and RTÉ Sport.'
    } <button class="text-btn" data-action="toggle-shield">${shield ? 'Turn shield off' : 'Turn on spoiler shield'}</button></p>`;
  }
  return '';
}

function sourceProblems(section) {
  const bad = state.feed.sources.filter((s) => s.section === section && !s.ok && !settings.hiddenSources.includes(s.id));
  return bad.length ? `<p class="section-sub">Couldn't load ${bad.map((s) => esc(s.name)).join(', ')} this time.</p>` : '';
}

function renderFeed(tab) {
  state.list = itemsFor(tab.section, state.source);
  state.rendered = 0;
  if (!state.list.length) {
    view.innerHTML = `${sectionHeader(tab)}<div class="empty">${
      state.feed.generatedAt ? (tab.id === 'reviews' ? 'No PS5 reviews in the last 7 days.' : 'Nothing here right now.') : 'No stories yet — the feed is still being built. Check back in a few minutes.'
    }</div>${sourceProblems(tab.section)}`;
    return;
  }
  view.innerHTML = `${sectionHeader(tab)}<div class="feed"></div>${sourceProblems(tab.section)}`;
  renderMore();
}

/* ------------------------------------------------------------- trends */

function renderTrends() {
  const regions = state.trends.regions || {};
  const r = regions[settings.region] || { items: [] };
  const items = r.items || [];
  view.innerHTML = `
    <h2 class="section-title">Trending searches</h2>
    <p class="section-sub">Top Google searches in the past 24 hours.</p>
    <div class="segmented" role="group" aria-label="Region">
      ${['IE', 'GB'].map((id) => `<button data-region="${id}" aria-pressed="${settings.region === id}">${id === 'IE' ? '🇮🇪 Ireland' : '🇬🇧 United Kingdom'}</button>`).join('')}
    </div>
    ${
      items.length
        ? `<ol class="trend-list">${items
            .map(
              (t, k) => `<li class="trend${state.openTrend === `${settings.region}-${k}` ? ' open' : ''}" data-key="${settings.region}-${k}">
            <button class="trend-row" aria-expanded="${state.openTrend === `${settings.region}-${k}`}">
              <span class="trend-rank">${k + 1}</span>
              <span><div class="trend-title">${esc(t.title)}</div><div class="trend-meta">${esc(timeAgo(t.published))}${t.news?.length ? ` · ${t.news.length} related stor${t.news.length === 1 ? 'y' : 'ies'}` : ''}</div></span>
              ${t.traffic ? `<span class="trend-traffic">${esc(t.traffic)} searches</span>` : ''}
            </button>
            <div class="trend-news">
              ${(t.news || [])
                .map(
                  (n) => `<a href="${esc(n.url)}" target="_blank" rel="noopener noreferrer" class="${n.image ? '' : 'noimg'}"><span><div class="nt">${esc(n.title)}</div><div class="ns">${esc(n.source)}</div></span>${
                    n.image ? `<img src="${esc(n.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" />` : ''
                  }</a>`,
                )
                .join('')}
              <a class="google" href="${esc(t.search)}" target="_blank" rel="noopener noreferrer">Search Google for “${esc(t.title)}” →</a>
            </div>
          </li>`,
            )
            .join('')}</ol>`
        : `<div class="empty">${r.error ? `Couldn't load trends: ${esc(r.error)}` : 'No trending searches yet.'}</div>`
    }
    ${r.page ? `<p class="section-sub" style="margin-top:14px"><a href="${esc(r.page)}" target="_blank" rel="noopener noreferrer">Open Google Trends</a>${r.stale ? ' · showing the last saved list' : ''}</p>` : ''}`;
}

/* --------------------------------------------------------------- main */

function render() {
  const tab = TABS.find((t) => t.id === state.tab) || TABS[0];
  renderTabs();
  renderChips();
  if (!state.feed) {
    view.innerHTML = `<div class="feed">${'<div class="skeleton"></div>'.repeat(6)}</div>`;
    return;
  }
  if (tab.id === 'trending') renderTrends();
  else renderFeed(tab);
}

function setTab(id, { source = 'all' } = {}) {
  if (!visibleTabs().some((t) => t.id === id)) id = 'news';
  const changed = state.tab !== id || state.source !== source;
  state.tab = id;
  state.source = source;
  if (changed) window.scrollTo({ top: 0 });
  render();
}

/* ------------------------------------------------------------- reader */

const reader = $('#reader');
const readerArticle = $('#reader-article');
let currentItem = null;
let openedFromApp = false;

function cleanHtml(html) {
  // Content is sanitised at build time; this is a second line of defence.
  const doc = new DOMParser().parseFromString(`<div>${html}</div>`, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,form,link,meta').forEach((n) => n.remove());
  doc.querySelectorAll('*').forEach((el) => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
    if (el.tagName === 'A') {
      el.setAttribute('target', '_blank');
      el.setAttribute('rel', 'noopener noreferrer');
    }
    if (el.tagName === 'IMG') {
      el.setAttribute('loading', 'lazy');
      el.setAttribute('referrerpolicy', 'no-referrer');
      el.removeAttribute('width');
      el.removeAttribute('height');
    }
  });
  return doc.body.firstChild.innerHTML;
}

async function openReader(id) {
  const item = state.feed?.items.find((i) => i.id === id);
  if (!item) {
    closeReader(true);
    return;
  }
  currentItem = item;
  const src = sourceById(item.source);
  const reddit = item.reddit || item.source === 'til';
  $('#reader-source').textContent = src.name;
  $('#reader-open').href = item.url;
  $('#tldr-btn').disabled = false;
  document.body.classList.add('reading');
  reader.hidden = false;
  $('#reader-scroll').scrollTop = 0;

  const meta = [item.author, fmtDate(item.published), item.readingMinutes && `${item.readingMinutes} min read`].filter(Boolean);
  if (reddit && item.score != null) meta.push(`▲ ${compact(item.score)} · ${compact(item.comments || 0)} comments`);
  const score = item.section === 'reviews' && item.score != null ? `<span class="score ${scoreClass(item.score, item.scoreMax)}">${esc(item.score)}</span>` : '';

  const head = reddit
    ? `<div class="r-src">${badge(src)} ${esc(src.name)}</div>
       <p class="r-post">${esc(item.title)}</p>
       <div class="r-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
       <div class="btn-row" style="justify-content:flex-start">
         <a class="btn secondary" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Reddit thread</a>
         ${item.link && !/reddit\.com/.test(item.link) ? `<a class="btn secondary" href="${esc(item.link)}" target="_blank" rel="noopener noreferrer">Source: ${esc(host(item.link))}</a>` : ''}
       </div>`
    : `<div class="r-src">${badge(src)} ${esc(src.name)} ${score}</div>
       <h1 class="r-title">${esc(item.title)}</h1>
       <div class="r-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
       ${item.image ? `<img class="r-hero" src="${esc(item.image)}" alt="" referrerpolicy="no-referrer" />` : ''}`;

  readerArticle.innerHTML = `${head}<div id="tldr-slot"></div><div class="r-body" id="r-body"><div class="skeleton" style="height:240px"></div></div>`;

  let article = null;
  if (item.hasContent) {
    try {
      const res = await fetch(`data/articles/${item.id}.json`);
      if (res.ok) article = await res.json();
    } catch {}
  }
  if (currentItem !== item) return;
  const body = $('#r-body');
  if (article?.contentHtml) {
    item._text = article.textContent;
    body.innerHTML = `${reddit ? `<div class="r-divider">From ${esc(item.sourceSite || host(item.link))}${item.sourceTitle ? ` — ${esc(item.sourceTitle)}` : ''}</div>` : ''}${cleanHtml(article.contentHtml)}`;
  } else {
    item._text = [item.title, item.summary].filter(Boolean).join('. ');
    body.innerHTML = reddit
      ? ''
      : `${item.summary ? `<p>${esc(item.summary)}</p>` : ''}<div class="r-note">A reader version of this story isn't available.<br /><a class="btn" href="${esc(item.url)}" target="_blank" rel="noopener noreferrer">Open on ${esc(host(item.url))}</a></div>`;
    if (reddit) $('#tldr-btn').disabled = !item.summary;
  }
}

function closeReader(replace = false) {
  reader.hidden = true;
  document.body.classList.remove('reading');
  currentItem = null;
  readerArticle.innerHTML = '';
  if (replace && location.hash.startsWith('#read/')) history.replaceState(null, '', `#${state.tab}`);
}

/* -------------------------------------------------------------- TL;DR */

async function runTldr() {
  if (!currentItem) return;
  const item = currentItem;
  const slot = $('#tldr-slot');
  const btn = $('#tldr-btn');
  const text = item._text || '';
  if (text.split(/\s+/).length < 40) {
    toast('This one is already short enough!');
    return;
  }
  btn.disabled = true;
  const { summarize } = await import('./tldr.js');
  const mode = settings.tldr;
  slot.innerHTML = `<div class="tldr"><div class="tldr-head"><span>TL;DR</span><span id="tldr-engine"></span></div><div id="tldr-out" class="cursor"></div><div id="tldr-progress"></div><div class="tldr-foot" id="tldr-foot"></div></div>`;
  slot.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  const out = $('#tldr-out');
  const prog = $('#tldr-progress');
  const engineEl = $('#tldr-engine');
  let streamed = '';
  try {
    const result = await summarize(text, {
      title: item.title,
      mode,
      onEngine: (name) => (engineEl.textContent = name),
      onStatus: (msg, pct) => {
        if (currentItem !== item) return;
        prog.innerHTML = `<div class="progress"><i style="width:${Math.round((pct ?? 0) * 100)}%"></i></div><small>${esc(msg)}</small>`;
        if (pct == null) prog.innerHTML = `<small>${esc(msg)}</small>`;
      },
      onToken: (t) => {
        if (currentItem !== item) return;
        prog.innerHTML = '';
        streamed += t;
        out.innerHTML = bulletsHtml(streamed);
      },
    });
    if (currentItem !== item) return;
    out.classList.remove('cursor');
    prog.innerHTML = '';
    out.innerHTML = bulletsHtml(result.text);
    const foot = $('#tldr-foot');
    foot.innerHTML = `<span>${esc(result.note)}</span>`;
    if (mode === 'quick') {
      foot.insertAdjacentHTML('beforeend', `<button class="text-btn" data-action="tldr-ai">Try on-device AI</button>`);
    }
  } catch (err) {
    console.error(err);
    if (currentItem !== item) return;
    out.classList.remove('cursor');
    prog.innerHTML = '';
    out.innerHTML = `<p>Couldn't summarise on this device: ${esc(err.message || err)}.</p>`;
    $('#tldr-foot').innerHTML = mode === 'ai' ? `<button class="text-btn" data-action="tldr-quick">Use quick summary instead</button>` : '';
  } finally {
    btn.disabled = false;
  }
}

function bulletsHtml(text) {
  const lines = text
    .split(/\n+/)
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.)])\s*/, '').replace(/\*\*(.+?)\*\*/g, '$1').trim())
    .filter(Boolean);
  if (lines.length <= 1) return `<p>${esc(lines[0] || '')}</p>`;
  return `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
}

/* ------------------------------------------------------------ settings */

const sheet = $('#settings');

async function openSettings() {
  const radios = (name, value) => sheet.querySelectorAll(`input[name="${name}"]`).forEach((r) => (r.checked = r.value === value));
  radios('sport', settings.sport);
  radios('tldr', settings.tldr);
  radios('theme', settings.theme);
  const sources = state.feed?.sources || [];
  const groups = [
    ['news', 'News'],
    ['reviews', 'Reviews'],
    ['sports', 'Sport'],
  ];
  $('#source-toggles').innerHTML = groups
    .map(([sec]) =>
      sources
        .filter((s) => s.section === sec)
        .map(
          (s) => `<label class="toggle"><span class="name">${badge(s)} <span>${esc(s.name)}${
            s.ok ? '' : ` <span class="status">· unavailable</span>`
          }</span></span><input type="checkbox" class="switch" data-source-toggle="${s.id}" ${settings.hiddenSources.includes(s.id) ? '' : 'checked'} /></label>`,
        )
        .join(''),
    )
    .join('');
  $('#source-status').textContent = state.feed?.generatedAt ? `Feed built ${fmtDate(state.feed.generatedAt)}. Refreshes automatically every hour.` : '';
  sheet.showModal();
  const { describeEngine } = await import('./tldr.js');
  $('#tldr-hint').textContent = await describeEngine();
}

sheet.addEventListener('change', (e) => {
  const t = e.target;
  if (t.name === 'sport') {
    settings.sport = t.value;
    state.revealed.clear();
  } else if (t.name === 'tldr') settings.tldr = t.value;
  else if (t.name === 'theme') {
    settings.theme = t.value;
    applyTheme();
  } else if (t.dataset.sourceToggle) {
    const id = t.dataset.sourceToggle;
    settings.hiddenSources = settings.hiddenSources.filter((s) => s !== id);
    if (!t.checked) settings.hiddenSources.push(id);
    if (state.source === id) state.source = 'all';
  }
  saveSettings();
  if (!visibleTabs().some((x) => x.id === state.tab)) setTab('news');
  else render();
});

sheet.addEventListener('click', (e) => {
  if (e.target === sheet) sheet.close();
});

$('#clear-model').addEventListener('click', async () => {
  const { clearModel } = await import('./tldr.js');
  const freed = await clearModel();
  toast(freed ? 'Downloaded model deleted' : 'No downloaded model found');
});

/* -------------------------------------------------------------- events */

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (b) location.hash = b.dataset.tab;
});

chips.addEventListener('click', (e) => {
  const b = e.target.closest('[data-source]');
  if (!b) return;
  state.source = b.dataset.source;
  renderChips();
  renderFeed(TABS.find((t) => t.id === state.tab));
});

function activateCard(card) {
  const id = card.dataset.id;
  if (card.classList.contains('shielded')) {
    state.revealed.add(id);
    card.classList.remove('shielded');
    return;
  }
  openedFromApp = true;
  location.hash = `read/${id}`;
}

view.addEventListener('click', (e) => {
  const card = e.target.closest('.card');
  if (card) return activateCard(card);
  const region = e.target.closest('[data-region]');
  if (region) {
    settings.region = region.dataset.region;
    state.openTrend = null;
    saveSettings();
    return renderTrends();
  }
  const row = e.target.closest('.trend-row');
  if (row) {
    const li = row.closest('.trend');
    const open = !li.classList.contains('open');
    view.querySelectorAll('.trend.open').forEach((x) => {
      x.classList.remove('open');
      x.querySelector('.trend-row').setAttribute('aria-expanded', 'false');
    });
    li.classList.toggle('open', open);
    row.setAttribute('aria-expanded', String(open));
    state.openTrend = open ? li.dataset.key : null;
    return;
  }
  if (e.target.closest('[data-action="toggle-shield"]')) {
    settings.sport = settings.sport === 'shield' ? 'show' : 'shield';
    state.revealed.clear();
    saveSettings();
    render();
  }
});

view.addEventListener('keydown', (e) => {
  const card = e.target.closest('.card');
  if (card && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    activateCard(card);
  }
});

// Hide thumbnails that fail to load rather than leaving empty boxes.
document.addEventListener(
  'error',
  (e) => {
    const img = e.target;
    if (!(img instanceof HTMLImageElement)) return;
    const card = img.closest('.card');
    if (card) {
      card.classList.remove('hero');
      card.classList.add('no-img');
    }
    img.remove();
  },
  true,
);

$('#reader-back').addEventListener('click', () => {
  if (openedFromApp) history.back();
  else {
    closeReader(true);
    render();
  }
});

$('#tldr-btn').addEventListener('click', runTldr);

readerArticle.addEventListener('click', (e) => {
  const a = e.target.closest('[data-action]');
  if (!a) return;
  if (a.dataset.action === 'tldr-ai' || a.dataset.action === 'tldr-quick') {
    settings.tldr = a.dataset.action === 'tldr-ai' ? 'ai' : 'quick';
    saveSettings();
    runTldr();
  }
});

$('#font-btn').addEventListener('click', () => {
  const sizes = [17, 19, 21, 23];
  settings.font = sizes[(sizes.indexOf(settings.font) + 1) % sizes.length];
  saveSettings();
  applyTheme();
  toast(`Text size ${sizes.indexOf(settings.font) + 1} of ${sizes.length}`);
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !reader.hidden && !sheet.open) $('#reader-back').click();
});

$('#settings-btn').addEventListener('click', openSettings);

$('#refresh-btn').addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.classList.add('spinning');
  await loadData(true);
  btn.classList.remove('spinning');
  render();
  toast(state.feed.generatedAt ? `Feed built ${timeAgo(state.feed.generatedAt)}` : 'Feed not built yet');
});

new IntersectionObserver((entries) => entries.some((en) => en.isIntersecting) && renderMore(), { rootMargin: '800px' }).observe($('#sentinel'));

/* -------------------------------------------------------------- router */

function route() {
  const h = decodeURIComponent(location.hash.slice(1));
  if (h.startsWith('read/')) {
    if (state.feed) openReader(h.slice(5));
    return;
  }
  if (!reader.hidden) closeReader();
  openedFromApp = false;
  const tab = TABS.find((t) => t.id === h) ? h : state.tab || 'news';
  if (tab !== state.tab || !$('.feed, .trend-list, .empty', view)) setTab(tab);
}
window.addEventListener('hashchange', route);

async function init() {
  applyTheme();
  const h = location.hash.slice(1);
  if (TABS.some((t) => t.id === h)) state.tab = h;
  render();
  await loadData();
  render();
  if (location.hash.startsWith('#read/')) route();
  // Pick up a newer build when the app is left open.
  setInterval(async () => {
    const before = state.feed?.generatedAt;
    await loadData(true);
    if (state.feed.generatedAt !== before && reader.hidden) render();
  }, 15 * 60 * 1000);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
}

init();
