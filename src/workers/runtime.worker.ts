// ============================================================================
// Dedicated Headless JavaScript Runtime Web Worker
// Executes code safely off the main thread in strict mode
// ============================================================================

export interface WorkerExecuteMessage {
  id: string;
  code: string;
}

export interface WorkerResultMessage {
  id: string;
  success: boolean;
  output?: unknown;
  error?: string;
  logs: string[];
  executionTimeMs: number;
}

self.onmessage = async (event: MessageEvent<WorkerExecuteMessage>) => {
  const { id, code } = event.data;
  if (!id || typeof code !== 'string') return;

  const logs: string[] = [];
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

  try {
    const speak = (msg: unknown) => {
      logs.push(typeof msg === 'object' ? JSON.stringify(msg) : String(msg ?? ''));
    };
    (self as any).speak = speak;

    // 1. Compile first to validate syntax without executing any code
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    let compiledFn: any;
    let isExpression = false;
    try {
      compiledFn = new AsyncFunction('speak', `"use strict"; return (${code.replace(/;\s*$/, '')});`);
      isExpression = true;
    } catch {
      try {
        compiledFn = new AsyncFunction('speak', `"use strict";\n${code}`);
      } catch (compileErr) {
        throw compileErr;
      }
    }

    // 2. Execute exactly once
    let rawResult: unknown;
    if (isExpression || /\bawait\b/.test(code) || /\breturn\b/.test(code)) {
      rawResult = await compiledFn(speak);
    } else {
      rawResult = (0, eval)(`"use strict";\n${code}`);
    }
    if (rawResult instanceof Promise) {
      rawResult = await rawResult;
    }
    if (rawResult === 'use strict') {
      rawResult = undefined;
    }
    const executionTimeMs = Math.max(1, Math.round(performance.now() - start));

    let output = rawResult;
    if (output === undefined && logs.length > 0) {
      output = logs.join('\n');
    }

    const response: WorkerResultMessage = {
      id,
      success: true,
      output,
      logs,
      executionTimeMs,
    };
    self.postMessage(response);
  } catch (err) {
    const executionTimeMs = Math.max(1, Math.round(performance.now() - start));
    const response: WorkerResultMessage = {
      id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      logs,
      executionTimeMs,
    };
    self.postMessage(response);
  } finally {
    console.log = originalLog;
    console.warn = originalWarn;
    console.error = originalError;
  }
};
