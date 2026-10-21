// ============================================================================
// How much context a WebLLM model gets, from what it costs. The model's working memory (its KV
// cache: the keys and values of every token it can hold) is set aside in full when it loads, and
// it can be bigger than the weights (Qwen3 0.6B: about 470 MB for 4,096 tokens, against 352 MB of
// weights). The cost of one token comes from the model's own config; the budget from the device.
// The context is what the budget holds, never more than Chatty's own limit for the model (what
// it asks for today) and never less than one turn needs.
// ============================================================================

/** One turn's least: the trimmed prompt (system prompt and request) and room for a reply */
export const MIN_CONTEXT = 3072;

/** The device, as far as the browser tells */
export interface DeviceMemory {
  /** iPhone or iPad: Safari, which has no memory API and stops a tab at about 2 GB */
  appleMobile: boolean;
  /** Another phone or tablet (Android) */
  phone: boolean;
  /** navigator.deviceMemory: the RAM in GB, rounded down and capped at 8 (Chrome only) */
  memoryGb?: number;
}

export function currentDevice(): DeviceMemory {
  const nav = (typeof navigator !== 'undefined' ? navigator : {}) as Navigator & { deviceMemory?: number };
  const ua = nav.userAgent ?? '';
  const appleMobile = /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints ?? 0) > 1);
  return { appleMobile, phone: !appleMobile && /Android|Mobile/.test(ua), memoryGb: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : undefined };
}

const MB = 1024 * 1024;

/**
 * The memory a model's KV cache may take. iPhone and iPad: a fixed share of Safari's tab limit
 * (the weights, WebLLM's worker and the page need the rest). Other phones and computers: by
 * their RAM where the browser says (Chrome), else a computer's usual.
 */
export function workingMemoryBudget(device: DeviceMemory): number {
  if (device.appleMobile) return 384 * MB;
  const gb = device.memoryGb;
  if (device.phone) return gb !== undefined && gb >= 8 ? 768 * MB : 512 * MB;
  return gb !== undefined && gb <= 4 ? 512 * MB : 1536 * MB;
}

type Config = Record<string, unknown> & { model_config?: Record<string, unknown> };
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined);

/**
 * Bytes one token takes in the KV cache, from the model's mlc-chat-config.json: a key and a value
 * per attention layer and KV head, head-size numbers each, in the model's float type (2 bytes
 * for f16 builds, 4 for f32). A hybrid model keeps them only in its attention layers: every
 * full_attention_interval-th one (Qwen3.5: every 4th; the rest hold a fixed-size state), or those
 * layer_types names. A config that doesn't say counts every layer, which can only overestimate.
 * Sizes may sit in model_config.text_config (Gemma 3). Null when the config lacks them.
 */
export function kvBytesPerToken(config: Config | null): number | null {
  if (!config) return null;
  const outer = (config.model_config ?? config) as Record<string, unknown>;
  const m = (outer.text_config && typeof outer.text_config === 'object' ? { ...outer, ...(outer.text_config as Record<string, unknown>) } : outer) as Record<string, unknown>;
  const layers = num(m.num_hidden_layers) ?? num(m.num_layers) ?? num(m.n_layer);
  const heads = num(m.num_attention_heads) ?? num(m.n_head);
  const kvHeads = num(m.num_key_value_heads) ?? num(m.num_kv_heads) ?? heads;
  const hidden = num(m.hidden_size) ?? num(m.n_embd);
  const headDim = num(m.head_dim) ?? (hidden && heads ? hidden / heads : undefined);
  if (!layers || !kvHeads || !headDim) return null;
  const types = Array.isArray(m.layer_types) ? (m.layer_types as unknown[]).map(String) : null;
  const interval = num(m.full_attention_interval);
  const attentionLayers = types
    ? types.filter((t) => /attention/i.test(t) && !/linear/i.test(t)).length || layers
    : interval
      ? Math.ceil(layers / interval)
      : layers;
  const bytes = /f32/.test(String(config.quantization ?? '')) ? 4 : 2;
  return attentionLayers * 2 * kvHeads * headDim * bytes;
}

/**
 * The model's own longest context, where its config gives one (max_position_embeddings; 0 when
 * it doesn't). Not MLC's context_window_size: that is the build's default (Gemma 2's says 4,096,
 * a model Chatty runs at 8,192).
 */
export function modelMaxContext(config: Config | null): number {
  if (!config) return 0;
  const m = (config.model_config ?? {}) as Record<string, unknown>;
  const text = (m.text_config ?? {}) as Record<string, unknown>;
  return num(m.max_position_embeddings) ?? num(text.max_position_embeddings) ?? 0;
}

/**
 * The context a model gets: what the budget holds (in steps of 256 tokens), no more than `cap`
 * (Chatty's limit for it) or the model's own longest, no less than MIN_CONTEXT. A model whose
 * cost isn't known gets the cap, as before.
 */
export function contextWindowFor(bytesPerToken: number | null, budgetBytes: number, cap: number, modelMax = 0): number {
  const top = modelMax > 0 ? Math.min(cap, modelMax) : cap;
  if (!bytesPerToken) return top;
  const fits = Math.floor(budgetBytes / bytesPerToken / 256) * 256;
  return Math.max(Math.min(MIN_CONTEXT, top), Math.min(top, fits));
}

/**
 * A model's mlc-chat-config.json: WebLLM's stored copy when there is one (its 'webllm/config'
 * cache), else from the network. Null when neither can be had (then the context is the cap).
 */
export async function readModelConfig(url: string): Promise<Config | null> {
  try {
    if (typeof caches !== 'undefined') {
      const stored = await (await caches.open('webllm/config')).match(url);
      if (stored) return (await stored.json()) as Config;
    }
    const response = await fetch(url);
    return response.ok ? ((await response.json()) as Config) : null;
  } catch {
    return null;
  }
}
