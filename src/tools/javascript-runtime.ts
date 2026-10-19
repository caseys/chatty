// ============================================================================
// JavaScript Runtime Tool for Gemma
// Supports Sandboxed IFrame (default, with DOM/visual rendering),
// Web Worker (headless background compute), and Direct Eval ((0, eval) strict).
// ============================================================================

import type { LlmRuntimeProvider, ToolDefinition } from '../types/index.ts';
import { loopProtect } from './loop-protect.ts';
import { playNotesHelper } from './music-tool.ts';
import { fetchWikipediaSummary } from './web-tools.ts';

export type JavascriptExecutionMode = 'iframe' | 'worker' | 'eval';

export interface JavascriptExecutionResult {
  success: boolean;
  output?: unknown;
  error?: string;
  logs: string[];
  spokenTexts?: string[];
  hasVisualOutput: boolean;
  executionTimeMs: number;
  code: string;
  mode: JavascriptExecutionMode;
  task?: string;
}

export interface ExecutionContextOptions {
  onSpeak?: (text: string) => void;
  audioContextAccessor?: () => Promise<AudioContext | null> | AudioContext | null;
  rootElement?: HTMLElement | null;
}

export interface JavascriptTaskInput {
  task?: string;
  code?: string;
  mode?: JavascriptExecutionMode;
}

export type JavascriptExecutionCallback = (result: JavascriptExecutionResult) => void;

export interface JavascriptRuntimeOptions {
  mode?: JavascriptExecutionMode;
  timeoutMs?: number;
  llmProvider?: LlmRuntimeProvider;
  onResult?: JavascriptExecutionCallback;
  onVisualChange?: (hasVisual: boolean, iframe: HTMLIFrameElement | null) => void;
  iframeContainer?: HTMLElement | null;
}

export const CODING_AGENT_SYSTEM_PROMPT = [
  'You are a single-use browser application coding agent.',
  'Write self-contained, working JavaScript to implement anything requested by the user in the browser.',
  'Available runtime environments: "iframe" (for interactive DOM apps, games, canvas visuals, Web Audio, animations, timers, Web APIs), "worker" (for heavy background math/loops), "eval" (for quick math expressions).',
  'For interactive widgets, games (e.g. Pong, Snake, Tic-Tac-Toe), timers, or tools: create clean HTML elements with CSS styles and event listeners, appending to document.getElementById("root") or document.body.',
  'For visual graphics, animations, or simulations: render onto an HTML5 <canvas> (or SVG) using requestAnimationFrame.',
  'For music, sound effects, or audio: use Web Audio API (new AudioContext, await ctx.resume(), OscillatorNode, GainNode).',
  'For data, calculations, or Web APIs: execute and return the result or log via console.log.',
  'Always use MODE: iframe for interactive DOM, canvas, games, audio, or visual widgets.',
  'Respond in this format:',
  'MODE: <iframe|worker|eval>',
  '```javascript',
  '<executable code>',
  '```',
].join(' ');

/**
 * Parses the single-use coding agent response for target execution mode and code.
 */
export function parseCodingAgentOutput(text: string): {
  mode?: JavascriptExecutionMode;
  code: string;
} {
  let mode: JavascriptExecutionMode | undefined;
  const modeMatch = text.match(/\bMODE:\s*(iframe|worker|eval)\b/i);
  if (modeMatch) {
    mode = modeMatch[1].toLowerCase() as JavascriptExecutionMode;
  }

  const codeBlockMatch = text.match(/```(?:javascript|js)?\s*\n([\s\S]*?)\n```/i);
  let code = codeBlockMatch ? codeBlockMatch[1].trim() : '';

  if (!code) {
    code = text.replace(/MODE:\s*(iframe|worker|eval)/gi, '').trim();
  }

  return { mode, code };
}

export interface PreparedExecutableCode {
  code: string;
  isProse: boolean;
}

/**
 * Inspects raw text from the model into executable JavaScript and classifies
 * whether it is an executable JavaScript code action or conversational prose.
 */
export function inspectExecutableCode(rawText: string): PreparedExecutableCode {
  let cleaned = (rawText || '').trim();

  // 1. Strip markdown fences if present
  let hadFences = false;
  const fenced = cleaned.match(/```(?:javascript|js)?\s*\n([\s\S]*?)(?:\n```|$)/i);
  if (fenced) {
    cleaned = fenced[1].trim();
    hadFences = true;
  } else if (cleaned.startsWith('```') && cleaned.endsWith('```')) {
    cleaned = cleaned.replace(/^```[a-z]*\n?/i, '').replace(/\n?```$/, '').trim();
    hadFences = true;
  }

  // 2. Remove any rogue <|...|> or <tool_call> tags
  cleaned = cleaned.replace(/<\|[a-z0-9_]+\|?>/gi, '').replace(/<\/?\|?tool_call\|?>/gi, '').trim();

  // 3. If empty, speak a polite ready message
  if (!cleaned) {
    return { code: 'speak("I am ready to help.");', isProse: true };
  }

  // 3b. If the model responded with a single quoted string like "Hello" or 'Good morning', it is conversational prose
  const singleQuotedMatch = cleaned.match(/^["']([^"'\r\n]*)["']$/);
  if (singleQuotedMatch) {
    return { code: `speak(${JSON.stringify(singleQuotedMatch[1])});`, isProse: true };
  }

  // 4. Test if cleaned is syntactically valid JavaScript code
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  let isValidJs = false;
  try {
    new AsyncFunction('speak', 'playNotes', 'searchWikipedia', 'root', `"use strict";\n${cleaned}`);
    isValidJs = true;
  } catch {
    try {
      new AsyncFunction('speak', 'playNotes', 'searchWikipedia', 'root', `"use strict"; return (${cleaned.replace(/;\s*$/, '')});`);
      isValidJs = true;
    } catch {
      isValidJs = false;
    }
  }

  // Guard against conversational prose that happens to parse as comma expressions or bare identifier calls
  // (e.g. "Sure, thanks", "Hi, there", "Sure (thanks)", "Yes, please", "Okay, thanks")
  if (isValidJs && !hadFences) {
    const hasJsKeywordsOrBuiltins = /\b(?:const|let|var|function|class|new|await|async|return|throw|if|while|for|switch|try|catch|import|export|typeof|instanceof|speak|playNotes|searchWikipedia|root|alert|prompt|confirm|fetch|requestAnimationFrame|cancelAnimationFrame|setTimeout|setInterval|clearTimeout|clearInterval|console|document|window|Math|JSON|Date|Audio|localStorage|sessionStorage)\b/.test(cleaned);
    const hasJsSyntaxOrOperators = /[=;{}[\].=>]/.test(cleaned) || /\([^)]*['"][^)]*\)/.test(cleaned) || /\(\s*\)/.test(cleaned);
    if (!hasJsKeywordsOrBuiltins && !hasJsSyntaxOrOperators) {
      isValidJs = false;
    }
  }

  if (isValidJs) {
    return { code: cleaned, isProse: false };
  }

  // 5. If it's a simple arithmetic expression or number (e.g. 42 or 3 * 7), compute and speak it
  if (/^\d+(?:\s*[\+\-\*\/\%]\s*\d+)*$/.test(cleaned)) {
    return { code: `speak(String(${cleaned}));`, isProse: false };
  }

  // 6. Otherwise, it's natural language conversational text. Unquote bare quoted prose if present.
  const bareQuoted = cleaned.match(/^["']([\s\S]*?)["']$/);
  const unquotedProse = bareQuoted ? bareQuoted[1] : cleaned;
  return { code: `speak(${JSON.stringify(unquotedProse)});`, isProse: true };
}

/**
 * Prepares raw text from the model into executable JavaScript.
 * Automatically extracts code fences, strips rogue tokens, and
 * wraps conversational speech into speak("...") if no code was written.
 */
export function prepareExecutableCode(rawText: string): string {
  return inspectExecutableCode(rawText).code;
}

/**
 * Automatically chooses the optimal runtime environment based on APIs in the code.
 */
export function detectRecommendedMode(code: string): JavascriptExecutionMode {
  // 1. Audio, visual, DOM, interactive widgets, timers, MIDI, storage, or host helpers require sandboxed iframe
  if (
    /\b(document|window|canvas|getContext|Audio|AudioContext|webkitAudioContext|OscillatorNode|GainNode|requestMIDIAccess|svg|innerHTML|appendChild|addEventListener|setInterval|setTimeout|requestAnimationFrame|createElement|getElementById|querySelector|classList|style|onclick|root|playNotes|speak|searchWikipedia|localStorage|sessionStorage|alert|prompt|confirm|location|navigator)\b/i.test(
      code
    )
  ) {
    return 'iframe';
  }

  // 2. Heavy CPU compute or loops (without DOM, audio, storage, or host helpers) benefit from background web worker
  if (
    /\b(while|for)\s*\(/i.test(code) ||
    /\b(fibonacci|prime|sort|matrix|compute|simulation|worker)\b/i.test(code)
  ) {
    return 'worker';
  }

  // 3. Lightweight calculation or date/arithmetic expression
  return 'eval';
}

function hasTopLevelReturn(code: string): boolean {
  const withoutStrings = code.replace(/(['"\x60])(?:\\.|(?!\1)[^\\\x60])*\1/gs, '""');
  const withoutComments = withoutStrings.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*/g, '');
  return /\breturn\b/.test(withoutComments);
}

interface PendingIframeRun {
  options?: ExecutionContextOptions;
  spokenTexts: string[];
  timer: ReturnType<typeof setTimeout>;
  finish: (data: Record<string, any> | null, errorMessage?: string) => void;
}

export class JavascriptRuntime {
  private mode: JavascriptExecutionMode;
  private timeoutMs: number;
  private llmProvider?: LlmRuntimeProvider;
  private onResult?: JavascriptExecutionCallback;
  private onVisualChange?: (hasVisual: boolean, iframe: HTMLIFrameElement | null) => void;
  private iframeContainer: HTMLElement | null = null;
  private activeIframe: HTMLIFrameElement | null = null;
  private iframeReadyPromise: Promise<void> | null = null;
  private worker: Worker | null = null;
  private reqCounter = 0;
  private defaultOptions: ExecutionContextOptions | undefined;
  private lastRunOptions: ExecutionContextOptions | undefined;
  private onIframeLoad?: (iframe: HTMLIFrameElement) => void;
  private pendingRuns = new Map<string, PendingIframeRun>();

  constructor(options?: JavascriptRuntimeOptions) {
    this.mode = options?.mode ?? 'iframe';
    this.timeoutMs = options?.timeoutMs ?? 5000;
    this.llmProvider = options?.llmProvider;
    this.onResult = options?.onResult;
    this.onVisualChange = options?.onVisualChange;
    this.iframeContainer = options?.iframeContainer ?? null;
  }

  setMode(mode: JavascriptExecutionMode): void {
    this.mode = mode;
  }

  getMode(): JavascriptExecutionMode {
    return this.mode;
  }

  setIframeContainer(container: HTMLElement | null): void {
    this.iframeContainer = container;
    if (this.activeIframe && container && this.activeIframe.parentElement !== container) {
      container.appendChild(this.activeIframe);
    }
  }

  getActiveIframe(): HTMLIFrameElement | null {
    return this.activeIframe;
  }

  /**
   * Default speak/audio context used for runs (and late async helper calls from
   * timers/rAF/event handlers) that do not supply their own ExecutionContextOptions.
   */
  setDefaultOptions(options: ExecutionContextOptions | undefined): void {
    this.defaultOptions = options;
  }

  /**
   * Registers a hook fired every time the sandbox iframe document (re)loads, so the host
   * can (re)attach listeners to iframe.contentWindow. Fires immediately if already loaded.
   */
  setIframeLoadListener(listener: ((iframe: HTMLIFrameElement) => void) | undefined): void {
    this.onIframeLoad = listener;
    const iframe = this.activeIframe;
    if (listener && iframe?.contentDocument?.readyState === 'complete' && iframe.contentDocument.getElementById('root')) {
      listener(iframe);
    }
  }

  /**
   * Fully resets the visual screen: kills timers, rAF loops, audio and body-appended elements by
   * recreating the iframe document. Pending runs are settled with an error.
   */
  async resetVisual(): Promise<void> {
    const hadIframe = Boolean(this.activeIframe);
    this.abortPendingRuns('Visual screen was cleared');
    if (this.activeIframe) {
      this.activeIframe.style.pointerEvents = 'none';
      this.activeIframe.remove();
      this.activeIframe = null;
      this.iframeReadyPromise = null;
    }
    if (hadIframe && typeof document !== 'undefined' && this.iframeContainer) {
      this.ensureIframe();
      await this.iframeReadyPromise;
    }
  }

  /** True when a previous run left something on the visual screen (root or body-level elements). */
  hasVisualContent(): boolean {
    try {
      const doc = this.activeIframe?.contentDocument;
      if (!doc?.body) return false;
      const root = doc.getElementById('root');
      if (root && root.childNodes.length > 0) return true;
      return Array.from(doc.body.children).some(
        (el) => el !== root && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE'
      );
    } catch {
      return false;
    }
  }

  private abortPendingRuns(reason: string): void {
    for (const run of Array.from(this.pendingRuns.values())) {
      run.finish(null, reason);
    }
    this.pendingRuns.clear();
  }

  setLlmProvider(provider: LlmRuntimeProvider): void {
    this.llmProvider = provider;
  }

  getLlmProvider(): LlmRuntimeProvider | undefined {
    return this.llmProvider;
  }

  /**
   * Evaluates if a string is direct JavaScript code rather than a natural language task description.
   */
  isProbableCode(input: string): boolean {
    const trimmed = input.trim();
    if (!trimmed) return false;
    if (/^(?:const|let|var|function|return|import|class|\(0,\s*eval\))\b/.test(trimmed)) {
      return true;
    }
    if (/[;{}]$/.test(trimmed) || trimmed.includes('=>') || trimmed.includes('console.log')) {
      return true;
    }
    if (/^Math\.\w+\(/.test(trimmed) || /^\d+\s*[\+\-\*\/]\s*\d+$/.test(trimmed)) {
      return true;
    }
    return false;
  }

  /**
   * Executes a task description or raw code.
   * If a natural language task query is provided, spins up a single-use coding agent
   * to write the JavaScript and choose the optimal runtime mode (iframe, worker, or eval).
   */
  async executeTask(
    input: string | JavascriptTaskInput,
    callback?: JavascriptExecutionCallback,
    options?: ExecutionContextOptions
  ): Promise<JavascriptExecutionResult> {
    let task = '';
    let code = '';
    let chosenMode: JavascriptExecutionMode | undefined;

    if (typeof input === 'string') {
      if (this.isProbableCode(input)) {
        code = input.trim();
      } else {
        task = input.trim();
      }
    } else {
      task = input.task?.trim() || '';
      code = input.code?.trim() || '';
      chosenMode = input.mode;
    }

    // If task is provided without code, spin up single-use coding agent
    if (task && !code) {
      if (!this.llmProvider) {
        if (this.isProbableCode(task)) {
          code = task;
        } else {
          return {
            success: false,
            error: 'Single-use coding agent requires an active LLM provider.',
            logs: [],
            hasVisualOutput: false,
            executionTimeMs: 0,
            code: '',
            mode: this.mode,
            task,
          };
        }
      } else {
        try {
          const agentPrompt = `Task: ${task}\nWrite executable JavaScript to accomplish this task in the browser and specify the best mode (iframe, worker, or eval).`;
          const genResult = await this.llmProvider.generate({
            turnId: `code_agent_${Date.now()}`,
            systemPrompt: CODING_AGENT_SYSTEM_PROMPT,
            messages: [{ role: 'user', content: agentPrompt }],
            temperature: 0.1,
            maxOutputTokens: 512,
          });

          const parsed = parseCodingAgentOutput(genResult.text);
          code = parsed.code;
          if (!chosenMode && parsed.mode) {
            chosenMode = parsed.mode;
          }
        } catch (err) {
          return {
            success: false,
            error: `Coding agent generation failed: ${err instanceof Error ? err.message : String(err)}`,
            logs: [],
            hasVisualOutput: false,
            executionTimeMs: 0,
            code: '',
            mode: this.mode,
            task,
          };
        }
      }
    }

    // Determine runtime environment to execute
    const targetMode = chosenMode || (code ? detectRecommendedMode(code) : this.mode);

    const res = await this.execute(code, callback, options, targetMode);
    res.task = task || undefined;
    return res;
  }

  /**
   * Executes code using the active mode ('iframe', 'worker', or 'eval').
   * Supports an optional callback and ExecutionContextOptions (for speak, playNotes, etc.).
   */
  async execute(
    code: string,
    callback?: JavascriptExecutionCallback,
    execOptions?: ExecutionContextOptions,
    modeOverride?: JavascriptExecutionMode
  ): Promise<JavascriptExecutionResult> {
    const trimmedCode = code.trim();
    const options = execOptions ?? this.defaultOptions;
    const runMode = modeOverride ?? this.mode;
    let result: JavascriptExecutionResult;

    const proc = (globalThis as unknown as { process?: { env?: Record<string, string> } }).process;
    const isNodeOrTest = Boolean(proc?.env?.VITEST || proc?.env?.NODE_ENV === 'test');

    const effectiveMode =
      runMode === 'iframe' && detectRecommendedMode(trimmedCode) === 'worker'
        ? 'worker'
        : runMode;

    // Guard loops so a synchronous infinite loop throws instead of freezing the page.
    const protectedCode = loopProtect(trimmedCode);

    if (isNodeOrTest && (effectiveMode === 'worker' || effectiveMode === 'iframe')) {
      result = await this.executeInEval(protectedCode, options);
      result.mode = effectiveMode;
    } else if (effectiveMode === 'worker') {
      result = await this.executeInWorker(protectedCode);
    } else if (effectiveMode === 'eval' || typeof document === 'undefined') {
      result = await this.executeInEval(protectedCode, options);
    } else {
      // Default: 'iframe'
      result = await this.executeInIframe(protectedCode, options);
    }

    callback?.(result);
    this.onResult?.(result);
    return result;
  }

  // --------------------------------------------------------------------------
  // 1. Direct Eval ((0, eval) in strict mode to protect local scope)
  // --------------------------------------------------------------------------

  private async executeInEval(
    code: string,
    options?: ExecutionContextOptions
  ): Promise<JavascriptExecutionResult> {
    const logs: string[] = [];
    const spokenTexts: string[] = [];
    const start = performance.now();

    const originalLog = console.log;
    const originalWarn = console.warn;
    const originalError = console.error;

    console.log = (...args: unknown[]) => {
      logs.push(args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };
    console.warn = (...args: unknown[]) => {
      logs.push('[warn] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };
    console.error = (...args: unknown[]) => {
      logs.push('[error] ' + args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    };

    const speak = (msg: unknown) => {
      const text = typeof msg === 'object' ? JSON.stringify(msg) : String(msg ?? '');
      spokenTexts.push(text);
      options?.onSpeak?.(text);
    };

    const playNotes = async (notes: string, tempo?: number) => {
      return playNotesHelper(notes, tempo, undefined, options?.audioContextAccessor);
    };

    const searchWikipedia = async (query: string) => {
      return fetchWikipediaSummary(query);
    };

    // Eval mode never touches the host DOM; only an explicitly supplied root is exposed.
    const root = options?.rootElement ?? null;

    const withTimeout = <T>(p: Promise<T> | T): Promise<T> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Execution timed out after ${this.timeoutMs}ms`)),
          this.timeoutMs
        );
      });
      return Promise.race([Promise.resolve(p), timeout]).finally(() => clearTimeout(timer));
    };

    try {
      let rawResult: any;
      // 1. Compile first to validate syntax without executing any code
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      let compiledFn: any;
      let isExpression = false;
      try {
        compiledFn = new AsyncFunction('speak', 'playNotes', 'searchWikipedia', 'root', `"use strict"; return (${code.replace(/;\s*$/, '')});`);
        isExpression = true;
      } catch {
        try {
          compiledFn = new AsyncFunction('speak', 'playNotes', 'searchWikipedia', 'root', `"use strict";\n${code}`);
        } catch (compileErr) {
          // Syntax error in the code itself. Thrown before ANY execution starts!
          throw compileErr;
        }
      }

      // 2. Execute exactly once
      if (isExpression || /\bawait\b/.test(code) || hasTopLevelReturn(code)) {
        rawResult = await withTimeout(compiledFn(speak, playNotes, searchWikipedia, root));
      } else {
        const g = globalThis as any;
        const prevSpeak = g.speak;
        const prevPlay = g.playNotes;
        const prevWiki = g.searchWikipedia;
        const prevRoot = g.root;
        try {
          g.speak = speak;
          g.playNotes = playNotes;
          g.searchWikipedia = searchWikipedia;
          g.root = root;
          rawResult = (0, eval)(`"use strict";\n${code}`);
        } finally {
          if (prevSpeak !== undefined) g.speak = prevSpeak; else delete g.speak;
          if (prevPlay !== undefined) g.playNotes = prevPlay; else delete g.playNotes;
          if (prevWiki !== undefined) g.searchWikipedia = prevWiki; else delete g.searchWikipedia;
          if (prevRoot !== undefined) g.root = prevRoot; else delete g.root;
        }
      }
      if (rawResult instanceof Promise) {
        rawResult = await withTimeout(rawResult);
      }
      if (rawResult === 'use strict') {
        rawResult = undefined;
      }
      const executionTimeMs = Math.max(1, Math.round(performance.now() - start));

      let output = rawResult;
      if (output === undefined && logs.length > 0) {
        output = logs.join('\n');
      }

      const hasVisualOutput = Boolean(root && root.children && root.children.length > 0);

      return {
        success: true,
        output,
        logs,
        spokenTexts,
        hasVisualOutput,
        executionTimeMs,
        code,
        mode: 'eval',
      };
    } catch (err) {
      const executionTimeMs = Math.max(1, Math.round(performance.now() - start));
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
        logs,
        spokenTexts,
        hasVisualOutput: false,
        executionTimeMs,
        code,
        mode: 'eval',
      };
    } finally {
      console.log = originalLog;
      console.warn = originalWarn;
      console.error = originalError;
    }
  }

  // --------------------------------------------------------------------------
  // 2. Web Worker Runner (Background headless isolation)
  // --------------------------------------------------------------------------

  private async executeInWorker(code: string): Promise<JavascriptExecutionResult> {
    if (typeof Worker === 'undefined') {
      console.error('[JavascriptRuntime] Web Worker is not supported in this environment, falling back to eval');
      return this.executeInEval(code);
    }

    if (!this.worker) {
      try {
        this.worker = new Worker(new URL('../workers/runtime.worker.ts', import.meta.url), {
          type: 'module',
        });
      } catch (err) {
        console.error('[JavascriptRuntime] Failed to spawn Web Worker, falling back to eval:', err);
        return this.executeInEval(code);
      }
    }

    const worker = this.worker;
    const reqId = `exec_${++this.reqCounter}_${Date.now()}`;
    const start = performance.now();

    return new Promise((resolve) => {
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

      const handler = (event: MessageEvent<any>) => {
        const data = event.data;
        if (!data || data.id !== reqId) return;

        cleanup();
        resolve({
          success: Boolean(data.success),
          output: data.output,
          error: data.error,
          logs: data.logs ?? [],
          spokenTexts: [],
          hasVisualOutput: false,
          executionTimeMs: data.executionTimeMs ?? Math.max(1, Math.round(performance.now() - start)),
          code,
          mode: 'worker',
        });
      };

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        worker.removeEventListener('message', handler);
      };

      timeoutTimer = setTimeout(() => {
        cleanup();
        // Terminate hanging worker (e.g. infinite loop)
        try {
          worker.terminate();
        } catch {
          // Ignore
        }
        this.worker = null;
        resolve({
          success: false,
          error: `Execution timed out after ${this.timeoutMs}ms`,
          logs: [],
          hasVisualOutput: false,
          executionTimeMs: this.timeoutMs,
          code,
          mode: 'worker',
        });
      }, this.timeoutMs);

      worker.addEventListener('message', handler);
      worker.postMessage({ id: reqId, code });
    });
  }

  // --------------------------------------------------------------------------
  // 3. Sandboxed IFrame Runner (Visual DOM/Canvas rendering + Safe Execution)
  // --------------------------------------------------------------------------

  private ensureIframe(): HTMLIFrameElement {
    if (this.activeIframe && this.activeIframe.contentWindow) {
      return this.activeIframe;
    }

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
    iframe.setAttribute('allow', 'autoplay; midi');
    iframe.setAttribute('title', 'Chatty JavaScript Runtime Sandbox');
    iframe.style.position = 'absolute';
    iframe.style.inset = '0';
    iframe.style.width = '100%';
    iframe.style.height = '100%';
    iframe.style.border = 'none';
    iframe.style.background = 'transparent';
    iframe.style.pointerEvents = 'none';

    const runnerHtml = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="color-scheme" content="light dark">
  <style>
    /* Must match the host page's color-scheme, or the browser paints an opaque
       (white) backdrop behind the iframe regardless of background: transparent. */
    :root {
      color-scheme: light dark;
    }
    *, *::before, *::after {
      box-sizing: border-box;
    }
    html, body {
      margin: 0;
      padding: 0;
      width: 100vw;
      height: 100vh;
      width: 100dvw;
      height: 100dvh;
      overflow: hidden;
      background: transparent !important;
      pointer-events: none;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #f1f5f9;
      -webkit-font-smoothing: antialiased;
    }
    #root {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      width: 100dvw;
      height: 100dvh;
      pointer-events: none;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    #root > *, body > *:not(#root):not(script):not(style) {
      pointer-events: auto;
    }
    canvas, svg {
      max-width: 100vw;
      max-height: 100vh;
      display: block;
      pointer-events: auto;
      background: transparent;
    }
    table {
      border-collapse: collapse;
      margin: 8px 0;
      font-size: 13px;
      background: rgba(15, 23, 42, 0.85);
      border-radius: 8px;
      overflow: hidden;
      backdrop-filter: blur(12px);
    }
    th, td {
      border: 1px solid rgba(255,255,255,0.15);
      padding: 6px 12px;
      text-align: left;
    }
    th {
      background: rgba(255,255,255,0.12);
      font-weight: 600;
    }
    button, input, select {
      font-family: inherit;
      border-radius: 8px;
      padding: 8px 14px;
      border: 1px solid rgba(255,255,255,0.2);
      background: rgba(15, 23, 42, 0.8);
      color: white;
      backdrop-filter: blur(8px);
      pointer-events: auto;
    }
    button {
      cursor: pointer;
      font-weight: 500;
      transition: background 0.15s, transform 0.1s;
    }
    button:hover {
      background: rgba(56, 189, 248, 0.25);
      border-color: #38bdf8;
    }
    button:active {
      transform: scale(0.97);
    }
    input:focus, select:focus {
      outline: 2px solid #38bdf8;
    }
  </style>
</head>
<body>
  <div id="root"></div>
  <script>
    const hasTopLevelReturn = ${hasTopLevelReturn.toString()};
    let currentExecId = null;
    const pendingAsyncCalls = new Map();

    window.speak = (text) => {
      const s = typeof text === 'object' ? JSON.stringify(text) : String(text ?? '');
      window.parent.postMessage({ type: 'speak', id: currentExecId, text: s }, '*');
    };

    window.playNotes = (notes, tempo) => {
      return new Promise((resolve) => {
        const callId = Math.random().toString(36).slice(2);
        pendingAsyncCalls.set(callId, resolve);
        window.parent.postMessage({ type: 'playNotes', id: currentExecId, callId, notes, tempo }, '*');
      });
    };

    window.searchWikipedia = (query) => {
      return new Promise((resolve) => {
        const callId = Math.random().toString(36).slice(2);
        pendingAsyncCalls.set(callId, resolve);
        window.parent.postMessage({ type: 'searchWikipedia', id: currentExecId, callId, query }, '*');
      });
    };

    window.root = document.getElementById('root');

    window.addEventListener('message', async (event) => {
      const data = event.data;
      if (!data) return;

      if (data.type === 'async_response' && data.callId) {
        const resolver = pendingAsyncCalls.get(data.callId);
        if (resolver) {
          pendingAsyncCalls.delete(data.callId);
          resolver(data.result);
        }
        return;
      }

      if (data.type !== 'execute') return;
      const { id, code } = data;
      currentExecId = id;
      const logs = [];
      const origLog = console.log;
      const origWarn = console.warn;
      const origError = console.error;

      console.log = (...args) => logs.push(args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
      console.warn = (...args) => logs.push('[warn] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
      console.error = (...args) => logs.push('[error] ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));

      try {
        const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
        let compiledFn;
        let isExpression = false;
        try {
          compiledFn = new AsyncFunction('speak', 'playNotes', 'searchWikipedia', 'root', '"use strict"; return (' + code.replace(/;\\s*$/, '') + ');');
          isExpression = true;
        } catch {
          try {
            compiledFn = new AsyncFunction('speak', 'playNotes', 'searchWikipedia', 'root', '"use strict";\\n' + code);
          } catch (compileErr) {
            throw compileErr;
          }
        }

        let res;
        if (isExpression || /\\bawait\\b/.test(code) || hasTopLevelReturn(code)) {
          res = await compiledFn(window.speak, window.playNotes, window.searchWikipedia, window.root);
        } else {
          res = (0, eval)('"use strict";\\n' + code);
        }
        if (res instanceof Promise) {
          res = await res;
        }
        if (res === 'use strict') {
          res = undefined;
        }

        // Detect if DOM has rendered visual elements (canvas, svg, div, table, etc.)
        const rootEl = document.getElementById('root');
        const hasVisualElements =
          Boolean(rootEl && rootEl.childNodes.length > 0 && rootEl.innerHTML.trim().length > 0) ||
          Boolean(document.querySelector('canvas, svg, table, img, video, form, button, input, div:not(#root)')) ||
          Array.from(document.body.children).some(c => c !== rootEl && c.tagName !== 'SCRIPT' && c.tagName !== 'STYLE');

        let out = res;
        if (out === undefined && logs.length > 0) {
          out = logs.join('\\n');
        }
        // Functions, DOM nodes etc. can't be posted to the host; send a description instead
        try {
          structuredClone(out);
        } catch {
          out = typeof out === 'function' ? '[function ' + (out.name || 'anonymous') + ']' : String(out);
        }

        window.parent.postMessage({
          type: 'result',
          id,
          success: true,
          output: out,
          logs,
          hasVisual: hasVisualElements,
        }, '*');
      } catch (err) {
        window.parent.postMessage({
          type: 'result',
          id,
          success: false,
          error: err ? (err.message || String(err)) : String(err),
          logs,
          hasVisual: false,
        }, '*');
      } finally {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
      }
    });

    // Notify parent that iframe is ready
    window.parent.postMessage({ type: 'iframe_ready' }, '*');
  </script>
</body>
</html>`;

    this.activeIframe = iframe;
    window.addEventListener('message', this.handleHostMessage);
    this.iframeReadyPromise = new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          window.removeEventListener('message', onReady);
          resolve();
        }
      };
      const onReady = (e: MessageEvent) => {
        if (e.source === iframe.contentWindow && e.data?.type === 'iframe_ready') {
          done();
        }
      };
      window.addEventListener('message', onReady);
      iframe.addEventListener('load', () => {
        if (this.activeIframe === iframe) this.onIframeLoad?.(iframe);
        setTimeout(done, 50);
      });
      // Timeout fallback for ready signal
      setTimeout(done, 600);
    });

    if (this.iframeContainer) {
      this.iframeContainer.innerHTML = '';
      this.iframeContainer.appendChild(iframe);
    } else {
      iframe.style.display = 'none';
      document.body.appendChild(iframe);
    }

    iframe.srcdoc = runnerHtml;
    return iframe;
  }

  /**
   * Persistent host-side listener for the current iframe. It outlives individual runs so that
   * speak/playNotes/searchWikipedia calls from timers, rAF loops and event handlers keep working.
   */
  private handleHostMessage = (event: MessageEvent<any>): void => {
    const iframe = this.activeIframe;
    if (!iframe || event.source !== iframe.contentWindow) return;
    const data = event.data;
    if (!data || typeof data !== 'object') return;

    if (data.type === 'speak') {
      const text = String(data.text ?? '');
      const run = this.pendingRuns.get(data.id);
      run?.spokenTexts.push(text);
      (run?.options ?? this.lastRunOptions ?? this.defaultOptions)?.onSpeak?.(text);
      return;
    }

    if (data.type === 'playNotes' || data.type === 'searchWikipedia') {
      void this.handleAsyncCall(iframe, data);
      return;
    }

    if (data.type === 'result') {
      const run = this.pendingRuns.get(data.id);
      if (!run) return; // Late result of a run that already timed out / was reset
      run.finish(data);
    }
  };

  private async handleAsyncCall(iframe: HTMLIFrameElement, data: Record<string, any>): Promise<void> {
    const opts = this.pendingRuns.get(data.id)?.options ?? this.lastRunOptions ?? this.defaultOptions;
    let result: unknown;
    try {
      if (data.type === 'playNotes') {
        result = await playNotesHelper(
          String(data.notes ?? ''),
          data.tempo,
          undefined,
          opts?.audioContextAccessor
        );
      } else {
        result = await fetchWikipediaSummary(String(data.query ?? ''));
      }
    } catch (err) {
      result = { success: false, error: err instanceof Error ? err.message : String(err) };
    }
    try {
      iframe.contentWindow?.postMessage({ type: 'async_response', callId: data.callId, result }, '*');
    } catch {
      // iframe went away
    }
  }

  private async executeInIframe(
    code: string,
    options?: ExecutionContextOptions
  ): Promise<JavascriptExecutionResult> {
    const iframe = this.ensureIframe();
    await this.iframeReadyPromise;

    if (!iframe.contentWindow || this.activeIframe !== iframe) {
      console.error('[JavascriptRuntime] IFrame contentWindow unavailable, falling back to eval');
      return this.executeInEval(code, options);
    }

    const reqId = `iframe_exec_${++this.reqCounter}_${Date.now()}`;
    const start = performance.now();
    const spokenTexts: string[] = [];
    this.lastRunOptions = options;

    return new Promise((resolve) => {
      const settle = (
        data: Record<string, any> | null,
        errorMessage?: string
      ): void => {
        clearTimeout(timer);
        this.pendingRuns.delete(reqId);
        if (!data) {
          resolve({
            success: false,
            error: errorMessage ?? 'IFrame execution failed',
            logs: [],
            spokenTexts,
            hasVisualOutput: false,
            executionTimeMs: Math.max(1, Math.round(performance.now() - start)),
            code,
            mode: 'iframe',
          });
          return;
        }
        const hasVisual = Boolean(data.hasVisual);
        this.onVisualChange?.(hasVisual, this.activeIframe);
        resolve({
          success: Boolean(data.success),
          output: data.output,
          error: data.error,
          logs: data.logs ?? [],
          spokenTexts,
          hasVisualOutput: hasVisual,
          executionTimeMs: Math.max(1, Math.round(performance.now() - start)),
          code,
          mode: 'iframe',
        });
      };

      const timer = setTimeout(() => {
        console.error(`[JavascriptRuntime] IFrame execution timed out after ${this.timeoutMs}ms`);
        settle(null, `IFrame execution timed out after ${this.timeoutMs}ms`);
      }, this.timeoutMs);

      this.pendingRuns.set(reqId, { options, spokenTexts, timer, finish: settle });
      iframe.contentWindow?.postMessage({ type: 'execute', id: reqId, code }, '*');
    });
  }

  dispose(): void {
    this.abortPendingRuns('Runtime disposed');
    if (typeof window !== 'undefined') {
      window.removeEventListener('message', this.handleHostMessage);
    }
    if (this.worker) {
      try {
        this.worker.terminate();
      } catch {
        // Ignore
      }
      this.worker = null;
    }
    if (this.activeIframe) {
      this.activeIframe.remove();
      this.activeIframe = null;
    }
  }
}

/**
 * Creates the standard ToolDefinition for Gemma integration as 'coder_agent'
 */
export function createCoderAgentTool(
  runtimeInstance: JavascriptRuntime,
  callback?: JavascriptExecutionCallback,
  toolName = 'coder_agent'
): ToolDefinition {
  return {
    name: toolName,
    description:
      'Executes dynamic browser actions, audio, visuals, calculations, simulations, or custom JavaScript scripts. Call this when the user asks to run code, compute, or simulate.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Task description or JavaScript code to execute',
        },
      },
      required: ['task'],
    },
    execute: async (args: Record<string, unknown>) => {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      const code = typeof args.code === 'string' ? args.code.trim() : '';
      const anyStr = Object.values(args).find(
        (v) => typeof v === 'string' && v.trim().length > 0
      ) as string | undefined;
      const input =
        task ||
        code ||
        String(
          args.prompt ||
            args.description ||
            args.query ||
            args.app ||
            args.game ||
            args.input ||
            anyStr ||
            ''
        ).trim();

      return runtimeInstance.executeTask(
        {
          task: task || (runtimeInstance.isProbableCode(input) ? undefined : input),
          code: code || (runtimeInstance.isProbableCode(input) ? input : undefined),
        },
        callback
      );
    },
  };
}

/**
 * Creates the standard ToolDefinition for Gemma integration (backwards-compatible alias)
 */
export function createJavascriptRuntimeTool(
  runtimeInstance: JavascriptRuntime,
  callback?: JavascriptExecutionCallback,
  toolName = 'javascript_runtime'
): ToolDefinition {
  return createCoderAgentTool(runtimeInstance, callback, toolName);
}
