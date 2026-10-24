// TL;DR summaries that run entirely on the reader's device.
//
// quick: an extractive summariser (no download, instant).
// ai:    1. Chrome's built-in on-device Summarizer (Gemini Nano) when present;
//        2. otherwise a small instruct LLM (Qwen2.5 0.5B) run in a Web Worker
//           with transformers.js on WebGPU, falling back to WASM. The model is
//           downloaded once and cached by the browser; article text never
//           leaves the device.

const MODEL_CACHE = 'transformers-cache';

/* ------------------------------------------------------- quick summary */

const STOP = new Set(
  `a about above after again against all am an and any are aren't as at be because been before being below between both but by can can't
  cannot could couldn't did didn't do does doesn't doing don't down during each few for from further had hadn't has hasn't have haven't
  having he he'd he'll he's her here here's hers herself him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its
  itself let's me more most mustn't my myself no nor not of off on once only or other ought our ours ourselves out over own same shan't
  she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then there there's these they
  they'd they'll they're they've this those through to too under until up very was wasn't we we'd we'll we're we've were weren't what
  what's when when's where where's which while who who's whom why why's with won't would wouldn't you you'd you'll you're you've your
  yours yourself yourselves said says also just like one two new will may get got year years time people mr mrs ms its told according`.split(/\s+/),
);

const words = (s) => (s.toLowerCase().match(/[\p{L}\p{N}']+/gu) || []).filter((w) => w.length > 2 && !STOP.has(w));

function sentences(text) {
  const parts = text
    .replace(/\s+/g, ' ')
    .match(/[^.!?]+(?:[.!?]+["'”’)\]]*|$)/g) || [];
  return parts.map((s) => s.trim()).filter((s) => s.length >= 40 && s.length <= 420 && !/^(advertisement|read more|related:|sign up)/i.test(s));
}

export function quickSummary(text, title = '', count) {
  const sents = sentences(text);
  if (sents.length <= 3) return sents.join('\n');
  const n = count || (sents.length > 30 ? 4 : 3);
  const freq = new Map();
  for (const s of sents) for (const w of words(s)) freq.set(w, (freq.get(w) || 0) + 1);
  const titleWords = new Set(words(title));
  const max = Math.max(...freq.values());
  const scored = sents.map((s, i) => {
    const ws = words(s);
    let score = 0;
    for (const w of ws) score += (freq.get(w) / max) * (titleWords.has(w) ? 2 : 1);
    score /= Math.sqrt(ws.length || 1);
    if (i < 3) score *= 1.35 - i * 0.1; // news leads matter
    return { s, i, score, set: new Set(ws) };
  });
  const picked = [];
  for (const c of [...scored].sort((a, b) => b.score - a.score)) {
    const dup = picked.some((p) => {
      const inter = [...c.set].filter((w) => p.set.has(w)).length;
      return inter / Math.min(c.set.size, p.set.size || 1) > 0.6;
    });
    if (!dup) picked.push(c);
    if (picked.length >= n) break;
  }
  return picked
    .sort((a, b) => a.i - b.i)
    .map((p) => p.s)
    .join('\n');
}

/* ---------------------------------------------------- Chrome built-in */

async function chromeSummarizerState() {
  try {
    if (!('Summarizer' in self)) return 'unavailable';
    return await self.Summarizer.availability({ type: 'key-points', format: 'plain-text', length: 'short', expectedInputLanguages: ['en'], outputLanguage: 'en' });
  } catch {
    return 'unavailable';
  }
}

async function chromeSummarize(text, { onStatus }) {
  const summarizer = await self.Summarizer.create({
    type: 'key-points',
    format: 'plain-text',
    length: 'short',
    expectedInputLanguages: ['en'],
    outputLanguage: 'en',
    sharedContext: 'A news article being read in a news app.',
    monitor(m) {
      m.addEventListener('downloadprogress', (e) => onStatus?.('Downloading Chrome’s on-device model…', e.loaded));
    },
  });
  try {
    onStatus?.('Summarising…', null);
    const input = text.split(/\s+/).slice(0, 2500).join(' ');
    const out = (await summarizer.summarize(input)).trim();
    // Some Chromium builds ship a stub that echoes the input back.
    if (!out || /model not available/i.test(out) || out.length > input.length * 0.6) throw new Error('Chrome summariser returned no usable summary');
    return out;
  } finally {
    summarizer.destroy?.();
  }
}

/* ------------------------------------------------- transformers.js LLM */

let worker;
let jobId = 0;
const jobs = new Map();

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./tldr-worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', (e) => {
    const job = jobs.get(e.data.id);
    if (!job) return;
    if (e.data.type === 'status') job.onStatus?.(e.data.message, e.data.progress);
    else if (e.data.type === 'engine') job.onEngine?.(e.data.name);
    else if (e.data.type === 'token') job.onToken?.(e.data.text);
    else if (e.data.type === 'done') {
      jobs.delete(e.data.id);
      job.resolve(e.data.text);
    } else if (e.data.type === 'error') {
      jobs.delete(e.data.id);
      job.reject(new Error(e.data.message));
    }
  });
  worker.addEventListener('error', (e) => {
    for (const [id, job] of jobs) {
      job.reject(new Error(e.message || 'the AI model could not be loaded (check your connection)'));
      jobs.delete(id);
    }
    worker = null;
  });
  return worker;
}

function llmSummarize(text, title, handlers) {
  return new Promise((resolve, reject) => {
    const id = ++jobId;
    jobs.set(id, { ...handlers, resolve, reject });
    getWorker().postMessage({ id, type: 'summarize', text, title });
  });
}

/* ---------------------------------------------------------------- API */

export async function summarize(text, { title = '', mode = 'quick', onStatus, onToken, onEngine } = {}) {
  if (mode !== 'ai') {
    onEngine?.('Quick');
    return { text: quickSummary(text, title), note: 'Key sentences picked from the article on your device.' };
  }
  if ((await chromeSummarizerState()) !== 'unavailable') {
    onEngine?.('Chrome on-device AI');
    try {
      const out = await chromeSummarize(text, { onStatus });
      return { text: out, note: 'Written by Chrome’s built-in on-device model. Nothing left your device.' };
    } catch (err) {
      console.warn('Chrome Summarizer failed, using bundled model', err);
    }
  }
  onEngine?.('On-device AI');
  const out = await llmSummarize(text, title, { onStatus, onToken, onEngine });
  return { text: out, note: 'Written by a small AI model running in your browser. AI summaries can get details wrong.' };
}

export async function describeEngine() {
  const chrome = await chromeSummarizerState();
  if (chrome === 'available') return 'On-device AI uses Chrome’s built-in model, which is already on this device.';
  if (chrome === 'downloadable' || chrome === 'downloading') return 'On-device AI uses Chrome’s built-in model; Chrome downloads it once on first use.';
  const gpu = 'gpu' in navigator ? 'using your GPU (WebGPU)' : 'on your CPU — this can take a minute on older devices';
  return `On-device AI downloads a small model (Qwen2.5 0.5B, roughly 0.5 GB) once, then summarises ${gpu}. Article text never leaves your device. Quick mode needs no download.`;
}

export async function clearModel() {
  try {
    return await caches.delete(MODEL_CACHE);
  } catch {
    return false;
  }
}
