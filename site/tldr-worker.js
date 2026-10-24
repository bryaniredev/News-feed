// Runs a small instruct LLM in the browser with transformers.js.
import { pipeline, TextStreamer, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';

const MODEL = 'onnx-community/Qwen2.5-0.5B-Instruct';
env.allowLocalModels = false;
env.useBrowserCache = true;

let generatorPromise;
let device = 'wasm';

async function pickDevice() {
  try {
    const adapter = await navigator.gpu?.requestAdapter();
    if (adapter) return { device: 'webgpu', dtype: adapter.features.has('shader-f16') ? 'q4f16' : 'q4' };
  } catch {}
  return { device: 'wasm', dtype: 'q4' };
}

function load(post) {
  if (generatorPromise) return generatorPromise;
  generatorPromise = (async () => {
    const choice = await pickDevice();
    device = choice.device;
    post({ type: 'engine', name: device === 'webgpu' ? 'On-device AI · GPU' : 'On-device AI · CPU' });
    const files = new Map();
    const progress_callback = (p) => {
      if (p.status === 'progress' && p.total) {
        files.set(p.file, { loaded: p.loaded, total: p.total });
        let loaded = 0;
        let total = 0;
        for (const f of files.values()) {
          loaded += f.loaded;
          total += f.total;
        }
        post({ type: 'status', message: `Downloading model… ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB (one-time)`, progress: loaded / total });
      } else if (p.status === 'ready') {
        post({ type: 'status', message: 'Loading model…', progress: 1 });
      }
    };
    try {
      return await pipeline('text-generation', MODEL, { device: choice.device, dtype: choice.dtype, progress_callback });
    } catch (err) {
      if (choice.device !== 'webgpu') throw err;
      device = 'wasm';
      post({ type: 'engine', name: 'On-device AI · CPU' });
      return pipeline('text-generation', MODEL, { device: 'wasm', dtype: 'q4', progress_callback });
    }
  })();
  generatorPromise.catch(() => (generatorPromise = null));
  return generatorPromise;
}

self.addEventListener('message', async (e) => {
  const { id, type, text, title } = e.data;
  if (type !== 'summarize') return;
  const post = (msg) => self.postMessage({ id, ...msg });
  try {
    const generator = await load(post);
    post({ type: 'status', message: 'Reading the article…', progress: null });
    const limit = device === 'webgpu' ? 1400 : 700;
    const body = text.split(/\s+/).slice(0, limit).join(' ');
    const messages = [
      {
        role: 'system',
        content: 'You summarise news articles. Reply with exactly 3 short bullet points, each starting with "- ". Use only facts from the article. No intro or outro.',
      },
      { role: 'user', content: `Title: ${title}\n\nArticle:\n${body}\n\nSummarise this article in 3 bullet points.` },
    ];
    const streamer = new TextStreamer(generator.tokenizer, {
      skip_prompt: true,
      skip_special_tokens: true,
      callback_function: (t) => post({ type: 'token', text: t }),
    });
    const out = await generator(messages, { max_new_tokens: 180, do_sample: false, repetition_penalty: 1.1, streamer });
    const reply = out[0].generated_text.at(-1).content;
    post({ type: 'done', text: reply });
  } catch (err) {
    post({ type: 'error', message: err?.message || String(err) });
  }
});
