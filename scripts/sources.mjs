// Every source the app shows. `feeds` are tried in order; if none of them
// returns items, the `page` is scraped for article links instead.

export const NEWS_SOURCES = [
  {
    id: 'unilad',
    name: 'UNILAD',
    section: 'news',
    color: '#e4002b',
    page: 'https://www.unilad.com/',
    feeds: ['https://www.unilad.com/rss', 'https://www.unilad.com/feed', 'https://www.unilad.com/rss.xml'],
    limit: 25,
  },
  {
    id: 'rte-news',
    name: 'RTÉ News',
    section: 'news',
    color: '#00a19a',
    page: 'https://www.rte.ie/news/headlines/',
    feeds: ['https://www.rte.ie/feeds/rss/?index=/news/', 'https://www.rte.ie/news/rss/news-headlines.xml'],
    limit: 25,
  },
  {
    id: 'wired',
    name: 'WIRED',
    section: 'news',
    color: '#111111',
    page: 'https://www.wired.com/',
    feeds: ['https://www.wired.com/feed/rss'],
    limit: 25,
  },
  {
    id: 'til',
    name: 'r/todayilearned',
    section: 'news',
    color: '#ff4500',
    kind: 'reddit',
    subreddit: 'todayilearned',
    page: 'https://www.reddit.com/r/todayilearned/',
    limit: 30,
  },
];

export const REVIEW_SOURCES = [
  {
    id: 'ign-ps5',
    name: 'IGN PS5 Reviews',
    section: 'reviews',
    color: '#bf1313',
    kind: 'ign-reviews',
    page: 'https://www.ign.com/reviews/games/ps5',
    // Fallback: IGN's article feeds, filtered down to PS5 game reviews.
    feeds: ['https://feeds.feedburner.com/ign/games-reviews', 'https://www.ign.com/rss/v2/articles/feed?categories=review'],
    maxAgeDays: 7,
    limit: 30,
  },
];

export const SPORT_SOURCES = [
  {
    id: 'tnt-football',
    name: 'TNT Sports Football',
    section: 'sports',
    color: '#00d2be',
    page: 'https://www.tntsports.co.uk/football/',
    feeds: ['https://www.tntsports.co.uk/football/rss.xml', 'https://www.tntsports.co.uk/rss.xml'],
    linkPattern: /_sto\d+\/story\.shtml$/,
    limit: 25,
  },
  {
    id: 'bbc-f1',
    name: 'BBC Sport F1',
    section: 'sports',
    color: '#ffd230',
    page: 'https://www.bbc.com/sport/formula1',
    feeds: ['https://feeds.bbci.co.uk/sport/formula1/rss.xml'],
    limit: 25,
  },
  {
    id: 'rte-sport',
    name: 'RTÉ Sport',
    section: 'sports',
    color: '#00a19a',
    page: 'https://www.rte.ie/sport/',
    feeds: ['https://www.rte.ie/feeds/rss/?index=/sport/'],
    limit: 25,
  },
];

export const TREND_REGIONS = [
  { id: 'IE', name: 'Ireland', page: 'https://trends.google.com/trending?geo=IE&hl=en-US' },
  { id: 'GB', name: 'United Kingdom', page: 'https://trends.google.com/trending?geo=GB&hl=en-US' },
];
