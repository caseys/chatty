// ============================================================================
// The messages between the page and the WebLLM worker (workers/webllm.worker.ts). WebLLM's library
// (6 MB) lives in the worker alone: the page never imports it, it sends these. Types only; nothing
// here runs.
//
// Every request but 'chatty-pace' and 'interrupt' carries an id, and everything the worker says
// about it carries the same id: any number of 'progress' (loads) or 'delta' (streamed replies),
// then one 'done' or one 'failed'.
// ============================================================================

/** A chat request: the fields Chatty sets (WebLLM's OpenAI-style request, named as it names them) */
export interface WebLlmChatRequest {
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  temperature: number;
  top_p: number;
  max_tokens: number;
  repetition_penalty?: number;
  presence_penalty?: number;
  /** Report the log probability of each token and of its likeliest alternatives (see top_logprobs) */
  logprobs?: boolean;
  /** How many alternatives to report at each position (0 to 5) */
  top_logprobs?: number;
  /** Holds the reply to a grammar (GBNF) */
  response_format?: { type: 'grammar'; grammar: string };
  extra_body?: { enable_thinking: boolean };
}

/** A token WebLLM sampled, with how likely it and its likeliest alternatives were */
export interface WebLlmTokenReport {
  token: string;
  logprob: number;
  top_logprobs: Array<{ token: string; logprob: number }>;
}

/** The answer to a request that isn't streamed: the whole reply, and its first token's report (null when none came) */
export interface WebLlmCompletion {
  text: string;
  firstToken: WebLlmTokenReport | null;
}

/** Page to worker */
export type WebLlmRequest =
  /** Pause (ms) before each weight piece and between shader builds, for iPhone Safari (0 elsewhere); no reply */
  | { kind: 'chatty-pace'; ms: number }
  /** Loads a model (downloading what isn't stored) with this context size; 'progress' while it does, then 'done' */
  | { kind: 'load'; id: number; model: string; contextWindow: number }
  /** A reply streamed: 'delta' for each piece of text, then 'done' */
  | { kind: 'chat'; id: number; request: WebLlmChatRequest }
  /** A reply not streamed: 'done' with a WebLlmCompletion */
  | { kind: 'complete'; id: number; request: WebLlmChatRequest }
  /** Stops the reply being generated (it ends as it would at its limit); no reply of its own */
  | { kind: 'interrupt' }
  /** Frees the model's GPU memory; 'done' */
  | { kind: 'unload'; id: number }
  /** Where an mlc model id's files are (WebLLM's list of prebuilt models); 'done' with the URL, or undefined for an unknown id */
  | { kind: 'model-url'; id: number; model: string }
  /** Deletes an mlc model id's stored files, config and library; 'done' */
  | { kind: 'delete-cache'; id: number; model: string };

/** Worker to page */
export type WebLlmEvent =
  /** What a load is doing ("Loading GPU shader modules[12/80]: ...") and how far along that step is (0..1) */
  | { kind: 'progress'; id: number; text: string; progress: number }
  /** A piece of a streamed reply */
  | { kind: 'delta'; id: number; content: string }
  /** The request is finished; value is what it asked for, if anything */
  | { kind: 'done'; id: number; value?: WebLlmCompletion | string }
  /** The request failed; message is the error as WebLLM wrote it (its toString) */
  | { kind: 'failed'; id: number; message: string };
