// ============================================================================
// Split phone pipeline (opt-in with ?pipeline=split; phones normally run the same one-model
// pipeline as desktop, on WebLLM): small ONNX models that fit a mobile browser tab.
//
//   Needle 3 (35 MB, CPU)  picks a ready-made tool or coder_agent on turns that ask for an action
//   Gemma 3 1B             writes spoken replies (prose only)
//   Qwen2.5-Coder 1.5B     writes JavaScript for coder_agent tasks
//
// Safari kills tabs near ~1.5 GB, so only one WebGPU model is in memory at a time: the coder
// is swapped in alone (chat is unloaded first) and chat reloads from the browser cache on the
// next turn. Needle is small and runs on the CPU, so it stays loaded throughout.
// ============================================================================

import type { JsonSchema, Tool } from 'cactus-needle/browser';
import { OnnxLlmProvider, type OnnxModelSpec } from '../runtimes/onnx-llm-provider.ts';
import { NEEDLE_LABEL, NeedleToolPicker, type PickedCall } from '../runtimes/needle-router.ts';
import { fetchWikipediaSummary } from '../tools/web-tools.ts';
import type { LlmGenerationOptions, LlmGenerationResult, LlmRuntimeProvider } from '../types/index.ts';

export const PHONE_MODEL_SPECS: Record<'chat' | 'chatSmall' | 'coder', OnnxModelSpec & { label: string }> = {
  chat: {
    label: 'Gemma 3 1B',
    repo: 'onnx-community/gemma-3-1b-it-ONNX',
    dtype: 'q4f16',
    contextLimit: 8192,
    maxOutputTokens: 256,
  },
  // Opt-in (?chat=270m) for phones that can't hold the 1B model
  chatSmall: {
    label: 'Gemma 3 270M',
    repo: 'onnx-community/gemma-3-270m-it-ONNX',
    // 4-bit weights degrade this tiny model badly
    dtype: 'fp16',
    contextLimit: 8192,
    maxOutputTokens: 256,
  },
  coder: {
    label: 'Qwen2.5-Coder 1.5B',
    repo: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct',
    dtype: 'q4f16',
    contextLimit: 8192,
    maxOutputTokens: 1536,
  },
};

export const PHONE_CHAT_SYSTEM_PROMPT = [
  'You are Chatty, a friendly voice assistant running on the user\'s phone.',
  'Reply in one to three short spoken sentences of plain text.',
  'No markdown, lists, code, emojis or stage directions.',
].join(' ');

type Group = 'chat' | 'coder';

/** Progress summed across a group's models, plus the model currently loading and its own bytes. */
export type PhoneProgress = (
  loaded: number,
  total: number,
  current?: { label: string; loaded: number; total: number }
) => void;

/** Owns the phone models: Needle stays loaded; chat and coder take turns on the GPU. */
export class PhoneModelSet {
  readonly needle = new NeedleToolPicker(ROUTER_TOOLS);
  readonly chat: OnnxLlmProvider;
  readonly chatSpec: (typeof PHONE_MODEL_SPECS)['chat'];
  readonly coder = new OnnxLlmProvider('qwen2.5-coder-1.5b', PHONE_MODEL_SPECS.coder);
  private active: Group | null = null;
  private switching: Promise<void> = Promise.resolve();

  /**
   * @param options.smallChat use Gemma 3 270M instead of 1B for chat
   * @param options.loadGapMs pause between unloading one model and loading the next
   * @param options.onModelLoadStart called as each model starts loading (crash diagnostics)
   */
  constructor(
    private readonly options: {
      smallChat?: boolean;
      loadGapMs?: number;
      onModelLoadStart?: (label: string) => void;
    } = {}
  ) {
    this.chatSpec = options.smallChat ? PHONE_MODEL_SPECS.chatSmall : PHONE_MODEL_SPECS.chat;
    this.chat = new OnnxLlmProvider(options.smallChat ? 'gemma-3-270m' : 'gemma-3-1b', this.chatSpec);
  }

  private async gap(): Promise<void> {
    const ms = this.options.loadGapMs ?? 0;
    if (ms > 0) await new Promise((r) => setTimeout(r, ms));
  }

  /**
   * Loads chat or coder, unloading the other first. The first chat load also loads Needle
   * (before chat, one at a time); onProgress reports bytes summed across both.
   */
  activate(group: Group, onProgress?: PhoneProgress): Promise<void> {
    const run = async () => {
      const model = group === 'chat' ? this.chat : this.coder;
      const other = group === 'chat' ? this.coder : this.chat;
      const freed = other.isLoaded;
      await other.dispose();
      this.active = group;
      let needleBytes = 0;
      if (group === 'chat' && !this.needle.isLoaded) {
        this.options.onModelLoadStart?.(NEEDLE_LABEL);
        await this.needle.initialize((loaded, total) => {
          needleBytes = total;
          onProgress?.(loaded, total, { label: NEEDLE_LABEL, loaded, total });
        });
        if (!model.isLoaded) await this.gap();
      }
      if (model.isLoaded) return;
      // Give the browser a moment to reclaim the unloaded model's memory
      if (freed) await this.gap();
      const label = group === 'chat' ? this.chatSpec.label : PHONE_MODEL_SPECS.coder.label;
      this.options.onModelLoadStart?.(label);
      await model.initialize((loaded, total) =>
        onProgress?.(needleBytes + loaded, needleBytes + total, { label, loaded, total })
      );
    };
    const next = this.switching.then(run, run);
    this.switching = next.catch(() => {});
    return next;
  }

  get activeGroup(): Group | null {
    return this.active;
  }

  async dispose(): Promise<void> {
    await Promise.all([this.needle.dispose(), this.chat.dispose(), this.coder.dispose()]);
    this.active = null;
  }
}

/** LlmRuntimeProvider view of one phone model that swaps its group in before generating. */
export class SwappingLlmProvider implements LlmRuntimeProvider {
  readonly supportsStreaming = true;
  readonly supportsCancellation = true;
  readonly supportsTools = false;

  constructor(
    private readonly set: PhoneModelSet,
    private readonly inner: OnnxLlmProvider,
    private readonly group: Group
  ) {}

  get id(): string {
    return this.inner.id;
  }
  get modelId(): string {
    return this.inner.modelId;
  }
  get contextLimit(): number {
    return this.inner.contextLimit;
  }
  get maxOutputTokens(): number {
    return this.inner.maxOutputTokens;
  }

  initialize(onProgress?: PhoneProgress): Promise<void> {
    return this.set.activate(this.group, onProgress);
  }

  async generate(options: LlmGenerationOptions): Promise<LlmGenerationResult> {
    if (this.set.activeGroup !== this.group || !this.inner.isLoaded) {
      await this.set.activate(this.group);
    }
    return this.inner.generate(options);
  }

  cancel(turnId?: string): void {
    this.set.chat.cancel();
    this.set.coder.cancel();
    void turnId;
  }

  async reset(): Promise<void> {}

  async dispose(): Promise<void> {
    await this.set.dispose();
  }
}

// ----------------------------------------------------------------------------
// Needle router
// ----------------------------------------------------------------------------

export type RouteDecision =
  | { kind: 'chat' }
  /** edit: changes the previous program (the coder is given it) */
  | { kind: 'code'; task: string; edit?: boolean }
  | { kind: 'tool'; name: 'set_timer' | 'search_wikipedia' | 'web_search'; args: Record<string, unknown> };

// Tools Needle picks from. Plain chat is decided by detectActionIntent() before Needle runs.
const ROUTER_TOOLS = {
  set_timer: tool('Start a countdown timer or reminder', {
    seconds: { type: 'number', description: 'Duration in seconds' },
    message: { type: 'string', description: 'Reminder text' },
  }, ['seconds']),
  search_wikipedia: tool('Look up facts about a specific named person, place, organization or event', {
    query: { type: 'string', description: 'Name to look up' },
  }, ['query']),
  web_search: tool('Look up a quick fact, unit conversion or definition', {
    query: { type: 'string', description: 'Search query' },
  }, ['query']),
  coder_agent: tool('Draw, make a game, animate, build a widget or chart, or play music or sounds', {
    task: { type: 'string', description: "The user's request" },
  }, ['task']),
};

function tool(description: string, properties: Record<string, JsonSchema>, required: string[]): Tool {
  return { description, inputSchema: { type: 'object', properties, required } };
}

/** Duration spoken in the user's words ("2 minutes", "an hour and 30 seconds"), in seconds. */
export function parseDurationSeconds(text: string): number | null {
  const words: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, fifteen: 15, twenty: 20, thirty: 30, forty: 40, 'forty-five': 45, fifty: 50, sixty: 60, ninety: 90, half: 0.5 };
  const unitSeconds = (u: string) => (/^h/.test(u) ? 3600 : /^m/.test(u) ? 60 : 1);
  let total = 0;
  let found = false;
  const re = /(\d+(?:\.\d+)?|a|an|one|two|three|four|five|six|seven|eight|nine|ten|fifteen|twenty|thirty|forty|forty-five|fifty|sixty|ninety|half)\s*(?:an?\s+)?(hours?|hrs?|minutes?|mins?|seconds?|secs?)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : words[m[1].toLowerCase()];
    if (n === undefined) continue;
    total += n * unitSeconds(m[2].toLowerCase());
    found = true;
  }
  return found && total > 0 ? Math.round(total) : null;
}

export type ActionIntent = 'timer' | 'code' | 'lookup';

/** The previous tool/program in this conversation, used to continue follow-ups. */
export type LastAction =
  | { conversationId?: string; kind: 'code'; task: string; code: string }
  | { conversationId?: string; kind: 'tool'; name: string; args: Record<string, unknown> };

/**
 * "make it bigger", "add a sun", "change the color to blue": a change to what the last
 * program made, rather than a new request.
 */
/**
 * The user says the last program didn't do it ("it didn't work", "no sound", "still the same",
 * "nothing happened"): the program it is about goes with the request, like an edit's
 */
export function isComplaint(text: string): boolean {
  const t = text.toLowerCase().replace(/[’']/g, "'").trim();
  return (
    /\b(?:didn't|did not|doesn't|does not|isn't|is not|wasn't|won't|can't|cannot|not|never|still|no)\b[^.?!]{0,30}\b(?:work|working|play|playing|sound|hear|show|showing|happen|happening|load|loop|looping|move|moving|change|changing|run|running|start|right|correct|fixed)\b/.test(t) ||
    /^(?:nothing (?:happen(?:ed|s)?|plays?|played|shows?|showed)|no sound|it's broken|broken|wrong|that's wrong|same thing|still the same|try again|fix it)\b/.test(t)
  );
}

export function isFollowUpEdit(text: string): boolean {
  const t = text.toLowerCase().trim();
  // Questions about it ("tell me more about it", "why is it red?") are conversation, not edits
  if (/^(tell|explain|what|why|how|who|where|when|is|are|was|does|did|do you|can you tell)\b/.test(t)) return false;
  const editVerb =
    /\b(do|redo|play|show|run|repeat|make|change|add|bigger|smaller|larger|faster|slower|louder|quieter|softer|more|less|move|turn|colou?r|paint|remove|delete|replace|speed|slow|rotate|flip|put|give|use|swap|switch|increase|decrease|double|halve)\b/.test(t);
  const refersBack =
    /\b(it|its|them|that|this|those|these|again|instead|too|also)\b/.test(t) ||
    /^(now|and|then|also|add|make|change)\b/.test(t);
  return editVerb && refersBack;
}

/**
 * Cheap keyword gate run before Needle. Requests with no action words are plain chat, and the
 * intent it finds is a safety net for Needle's pick (see TurnRouter.validate).
 */
export function detectActionIntent(text: string): ActionIntent | null {
  const t = text.toLowerCase();
  if (/\b(timer|remind(er)?|alarm|countdown)\b/.test(t) && parseDurationSeconds(t)) return 'timer';
  if (
    /\b(draw|sketch|paint|animat\w*|game|chart|graph|plot|widget|calculator|clock|stopwatch|visuali[sz]\w*|diagram|render|canvas)\b/.test(t) ||
    /\b(play|compose|make)\b.*\b(music|song|tune|melody|notes?|chords?|beat|sound|piano|drums?)\b/.test(t) ||
    /^(please\s+)?play\b/.test(t) ||
    /\b(build|make|create|show)\s+(me\s+)?(an?\s+)?(app|page|website|screen|animation|game|chart|widget)\b/.test(t)
  ) {
    return 'code';
  }
  if (
    /^(who|where|when)\s+(is|was|were|are|did)\b/.test(t) ||
    /^what\s+(is|was|are)\s+(the\s+)?([a-z]+\s+)?(capital|population|height|age|distance|meaning|definition)\b/.test(t) ||
    /^(what|who)\s+(is|was|are)\s+[a-z]+(\s+[a-z]+){0,3}\??$/.test(t) && /[A-Z]/.test(text.slice(1)) ||
    /\b(how (many|much|far|tall|old|long)|convert|define|definition of|look up|search for|wikipedia|population of|capital of)\b/.test(t)
  ) {
    return 'lookup';
  }
  return null;
}

/** Share of the model's words that appear in the user's text (catches args copied from examples). */
function wordOverlap(arg: string, userText: string): number {
  const words = arg.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  if (words.length === 0) return 0;
  const user = new Set(userText.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return words.filter((w) => user.has(w)).length / words.length;
}

/** The user's request without question/command filler, as a fallback search query. */
function queryFromText(text: string): string {
  return text
    .replace(/^(please\s+)?(can you\s+)?(tell me\s+)?(look up|search for|search|who|what|where|when)\s+(is|was|were|are|did)?\s*/i, '')
    .replace(/[?.!]+$/, '')
    .trim() || text;
}

export class TurnRouter {
  constructor(private readonly picker: Pick<NeedleToolPicker, 'pick'>) {}

  async route(userText: string, signal?: AbortSignal, last?: LastAction | null): Promise<RouteDecision> {
    // Follow-ups continue the previous action (Needle sees only the current message)
    if (last?.kind === 'code' && isFollowUpEdit(userText)) {
      return { kind: 'code', task: userText, edit: true };
    }
    const about = userText.match(/^(?:and\s+)?(?:what|how)\s+about\s+(.+?)[?.!]*$/i);
    if (about && last?.kind === 'tool' && (last.name === 'search_wikipedia' || last.name === 'web_search')) {
      return { kind: 'tool', name: last.name, args: { query: about[1].trim() } };
    }

    const intent = detectActionIntent(userText);
    if (!intent) return { kind: 'chat' };
    let decision: PickedCall | null = null;
    // Needle can't be cancelled mid-call, but it answers in well under a second
    if (!signal?.aborted) {
      try {
        decision = await this.picker.pick(userText);
      } catch (err) {
        console.warn('[Chatty Router] Needle failed; using the keyword intent:', err);
      }
    }
    return this.validate(decision, userText, intent);
  }

  /**
   * Repairs the router's pick using the user's own words: the keyword intent decides the tool
   * family, Needle only refines it (Wikipedia vs web search, timer message, cleaned query).
   */
  private validate(
    decision: PickedCall | null,
    userText: string,
    intent: ActionIntent
  ): RouteDecision {
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const fromUser = (arg: string) => arg && wordOverlap(arg, userText) >= 0.5;
    switch (intent) {
      case 'timer': {
        // Trust the duration in the user's words over the model's arithmetic
        const seconds = parseDurationSeconds(userText) ?? 60;
        const message = decision?.name === 'set_timer' ? str(decision.args.message) : '';
        return { kind: 'tool', name: 'set_timer', args: { seconds, message: fromUser(message) ? message : '' } };
      }
      case 'code': {
        const task = decision?.name === 'coder_agent' ? str(decision.args.task) : '';
        return { kind: 'code', task: fromUser(task) ? task : userText };
      }
      case 'lookup': {
        // Needle reliably picks Wikipedia for named people and places; anything else goes to
        // web search (instant answers for conversions and quick facts, then Wikipedia)
        const name = decision?.name === 'search_wikipedia' ? 'search_wikipedia' : 'web_search';
        const query = decision && (decision.name === 'web_search' || decision.name === 'search_wikipedia')
          ? str(decision.args.query)
          : '';
        return { kind: 'tool', name, args: { query: fromUser(query) ? query : queryFromText(userText) } };
      }
    }
  }
}

// ----------------------------------------------------------------------------
// Ready-made tools (no code generation needed)
// ----------------------------------------------------------------------------

export interface ReadyToolOutcome {
  /** A complete reply to speak as-is (skips the chat model) */
  say?: string;
  /** Information for the chat model to answer from */
  context?: string;
}

export async function runReadyTool(
  name: 'set_timer' | 'search_wikipedia' | 'web_search',
  args: Record<string, unknown>,
  ctx: { speakLater: (text: string) => void }
): Promise<ReadyToolOutcome> {
  switch (name) {
    case 'set_timer': {
      const seconds = Number(args.seconds);
      const message = String(args.message || '').trim() || "Time's up!";
      setTimeout(() => ctx.speakLater(message), seconds * 1000);
      return { say: `Okay, timer set for ${describeDuration(seconds)}.` };
    }
    case 'search_wikipedia': {
      const info = await fetchWikipediaSummary(String(args.query ?? ''));
      if (info.error || !info.summary) {
        return { context: `Wikipedia had nothing for "${args.query}". Say you couldn't find it.` };
      }
      return { context: `Wikipedia, "${info.title}": ${info.summary.slice(0, 1500)}` };
    }
    case 'web_search': {
      const query = String(args.query ?? '').trim();
      try {
        const res = await fetch(
          `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`
        );
        const data = (await res.json()) as { AbstractText?: string; Answer?: string; Definition?: string };
        const answer = data.Answer || data.AbstractText || data.Definition;
        if (answer) return { context: `Web answer for "${query}": ${String(answer).slice(0, 1500)}` };
      } catch {
        // Fall through to Wikipedia
      }
      const info = await fetchWikipediaSummary(query);
      if (info.summary) return { context: `Wikipedia, "${info.title}": ${info.summary.slice(0, 1500)}` };
      return { context: `No web results for "${query}". Answer from general knowledge and say you couldn't look it up.` };
    }
  }
}

function describeDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const part = (n: number, unit: string) => (n ? `${n} ${unit}${n === 1 ? '' : 's'}` : '');
  return [part(h, 'hour'), part(m, 'minute'), part(s, 'second')].filter(Boolean).join(' and ') || '0 seconds';
}
