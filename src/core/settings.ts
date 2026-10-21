// ============================================================================
// Application Settings & Model Preferences
// The chat model list (Gemma 4 on LiteRT-LM; Qwen, Llama and others on WebLLM), which models
// phones get, the Piper voice and the speech switch, persisted in localStorage & IndexedDB.
// ============================================================================

import type { WebLlmModelSpec } from '../runtimes/webllm-provider.ts';

export interface ChattySettings {
  chatModelId: string;
  codingModelId: string;
  voiceId: string;
  /** Off: no mic, no voice, and the speech models (Piper, Whistle) aren't loaded; chat is typed */
  speechEnabled: boolean;
  sidebarOpen: boolean;
}

export interface ModelOptionItem {
  id: string;
  name: string;
  description: string;
  /** Small enough for a phone browser tab */
  phone?: boolean;
  /** Download size, which the picker sorts by */
  downloadBytes?: number;
}

/**
 * Chat models run with WebLLM (MLC, on WebGPU in a worker) instead of LiteRT; the only ones
 * phones get. Memory figures are WebLLM's own estimates, including a 4,096-token context.
 */
export interface LocalChatModel extends ModelOptionItem, WebLlmModelSpec {
  label: string;
  /** Runs with Transformers.js (ONNX, WebGPU) instead of WebLLM: models WebLLM has no build of */
  onnx?: { repo: string; dtype: string };
}

const local = (
  id: string,
  label: string,
  mlcId: string,
  downloadMb: number,
  memoryMb: number,
  description: string,
  phone: boolean
): LocalChatModel => ({
  id,
  label,
  name: `${label} (~${downloadMb >= 1000 ? `${(downloadMb / 1000).toFixed(1)} GB` : `${downloadMb} MB`}${phone ? ', Phone' : ''})`,
  description: `${description} · needs ~${memoryMb >= 1000 ? `${(memoryMb / 1000).toFixed(1)} GB` : `${memoryMb} MB`} memory`,
  mlcId,
  sizeBytes: downloadMb * 1_000_000,
  // Phones: a 4,096-token context keeps the model's working memory small
  contextLimit: phone ? 4096 : 8192,
  // Room kept for the reply: a whole program (long ones, music and games, run past 1,000 tokens).
  // On phones' 4,096-token context this leaves about half for the prompt and the conversation.
  maxOutputTokens: 2048,
  phone,
});

export const LOCAL_CHAT_MODELS: ReadonlyArray<LocalChatModel> = [
  // Phone-sized (smallest memory first)
  local('gemma-3-1b', 'Gemma 3 1B', 'gemma3-1b-it-q4f16_1-MLC', 602, 711, 'Google Gemma 3, small', true),
  local('llama-3.2-1b', 'Llama 3.2 1B', 'Llama-3.2-1B-Instruct-q4f16_1-MLC', 705, 879, 'Meta on-device model', true),
  local('qwen2.5-coder-0.5b', 'Qwen2.5-Coder 0.5B', 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC', 290, 945, 'Small model tuned for code', true),
  local('qwen2.5-0.5b', 'Qwen2.5 0.5B', 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 290, 945, 'Smallest download', true),
  { ...local('qwen3-0.6b', 'Qwen3 0.6B', 'Qwen3-0.6B-q4f16_1-MLC', 352, 1403, 'Newer general model', true), noThinking: true },
  { ...local('qwen3.5-0.8b', 'Qwen3.5 0.8B', 'Qwen3.5-0.8B-q4f16_1-MLC', 424, 1629, 'Newest small Qwen', true), noThinking: true },
  // Desktop (smallest memory first)
  local('qwen2.5-coder-1.5b', 'Qwen2.5-Coder 1.5B', 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', 880, 1630, 'Strong at JavaScript', false),
  { ...local('qwen3-1.7b', 'Qwen3 1.7B', 'Qwen3-1.7B-q4f16_1-MLC', 968, 2037, 'General model', false), noThinking: true },
  { ...local('qwen3.5-2b', 'Qwen3.5 2B', 'Qwen3.5-2B-q4f16_1-MLC', 1059, 2245, 'Newest Qwen, small', false), noThinking: true },
  local('gemma-2-2b', 'Gemma 2 2B', 'gemma-2-2b-it-q4f16_1-MLC', 1493, 1895, 'Google Gemma 2', false),
  local('llama-3.2-3b', 'Llama 3.2 3B', 'Llama-3.2-3B-Instruct-q4f16_1-MLC', 1807, 2264, 'Meta on-device model', false),
  local('qwen2.5-coder-3b', 'Qwen2.5-Coder 3B', 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', 1748, 2505, 'Stronger at JavaScript', false),
  local('ministral-3-3b', 'Ministral 3 3B', 'Ministral-3-3B-Instruct-2512-BF16-q4f16_1-MLC', 1929, 2864, 'Mistral edge model (Dec 2025)', false),
  { ...local('qwen3-4b', 'Qwen3 4B', 'Qwen3-4B-q4f16_1-MLC', 2279, 3432, 'General model, good at code', false), noThinking: true },
  local('phi-4-mini', 'Phi-4-mini', 'Phi-4-mini-instruct-q4f16_1-MLC', 2158, 3438, 'Microsoft, strong reasoning', false),
  { ...local('qwen3.5-4b', 'Qwen3.5 4B', 'Qwen3.5-4B-q4f16_1-MLC', 2367, 3868, 'Newest Qwen, balanced', false), noThinking: true },
  local('qwen2.5-coder-7b', 'Qwen2.5-Coder 7B', 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC', 4296, 5107, 'Best at JavaScript, needs a strong GPU', false),
  { ...local('qwen3-8b', 'Qwen3 8B', 'Qwen3-8B-q4f16_1-MLC', 4608, 5696, 'General model, needs a strong GPU', false), noThinking: true },
  { ...local('qwen3.5-9b', 'Qwen3.5 9B', 'Qwen3.5-9B-q4f16_1-MLC', 5038, 6433, 'Newest Qwen, largest; needs a strong GPU', false), noThinking: true },
];

/** Phones start on Qwen3 0.6B */
export const DEFAULT_PHONE_CHAT_MODEL_ID = 'qwen3-0.6b';
/** Offered after a phone load dies (likely out of memory): the smallest memory footprint */
export const SMALLEST_PHONE_CHAT_MODEL_ID = 'llama-3.2-1b';

/** Whether phones offer (and keep) this chat model. */
export function isPhoneChatModel(id: string): boolean {
  return SUPPORTED_CHAT_MODELS.some((m) => m.id === id && m.phone);
}

/**
 * The chat model a phone runs: the one the user picked (see loadChatModelChoice) if phones can run
 * it, otherwise the phone default. Phones don't follow the desktop default or recommendation:
 * Gemma 4 E2B is phone-capable, but a phone only gets it when the user chose it.
 */
/** The default on other phones (Chrome on Android): Qwen3 1.7B */
export const ANDROID_PHONE_CHAT_MODEL_ID = 'qwen3-1.7b';

/** iPhone or iPad: every browser there is Safari underneath, which crashes on Gemma */
export function isAppleMobile(
  ua = typeof navigator !== 'undefined' ? navigator.userAgent : '',
  touchPoints = typeof navigator !== 'undefined' ? navigator.maxTouchPoints : 0
): boolean {
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && touchPoints > 1);
}

/** The phone default: Qwen3 0.6B on iPhone and iPad (Safari), Qwen3 1.7B on other phones (Chrome) */
export function phoneDefaultChatModelId(appleMobile = isAppleMobile()): string {
  return appleMobile ? DEFAULT_PHONE_CHAT_MODEL_ID : ANDROID_PHONE_CHAT_MODEL_ID;
}

export function resolvePhoneChatModelId(chosen: string | null, fallback = phoneDefaultChatModelId()): string {
  // Every model may be chosen on every device (the picker marks which suit a phone)
  const allowed = chosen && SUPPORTED_CHAT_MODELS.some((m) => m.id === chosen);
  return allowed ? chosen : fallback;
}

export function findLocalChatModel(id: string): LocalChatModel | undefined {
  return LOCAL_CHAT_MODELS.find((m) => m.id === id);
}

export const SUPPORTED_CHAT_MODELS: ReadonlyArray<ModelOptionItem> = [
  {
    id: 'gemma-4-e2b-it-web',
    name: 'Gemma 4 E2B (~1.95 GB, Fast, Phone: may crash)',
    description: 'Fast, efficient WebGPU inference',
    downloadBytes: 1_950_000_000,
    // Same Google LiteRT runtime as desktop; ~2 GB is near a phone tab's memory limit
    phone: true,
  },
  {
    id: 'gemma-4-e4b-it-web',
    name: 'Gemma 4 E4B (~2.89 GB, High Quality)',
    description: 'High quality, larger context reasoning',
    downloadBytes: 2_890_000_000,
  },
  ...LOCAL_CHAT_MODELS.map(({ id, name, description, phone, sizeBytes }) => ({ id, name, description, phone, downloadBytes: sizeBytes })),
];

export const SUPPORTED_CODING_MODELS: ReadonlyArray<ModelOptionItem> = [
  {
    id: 'gemma-4-e2b-it-web',
    name: 'Gemma 4 E2B (~1.95 GB, Fast)',
    description: 'Fast code generation and tool selection',
  },
  {
    id: 'gemma-4-e4b-it-web',
    name: 'Gemma 4 E4B (~2.89 GB, High Quality)',
    description: 'Deep reasoning for complex JavaScript subagent tasks',
  },
];

export const SUPPORTED_PIPER_VOICES: ReadonlyArray<ModelOptionItem> = [
  {
    id: 'en_US-hfc_female-medium',
    name: 'US Female',
    description: 'Natural female voice',
  },
  {
    id: 'en_US-hfc_male-medium',
    name: 'US Male',
    description: 'Natural male voice',
  },
];

export const DEFAULT_SETTINGS: ChattySettings = {
  chatModelId: 'qwen3.5-2b',
  codingModelId: 'qwen3.5-2b',
  voiceId: 'en_US-hfc_female-medium',
  speechEnabled: true,
  sidebarOpen: false,
};

export const SETTINGS_STORAGE_KEY = 'chatty_user_settings';

export function loadSettingsFromStorage(): ChattySettings {
  if (typeof localStorage === 'undefined') {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw) as Partial<ChattySettings>;
    return {
      chatModelId:
        parsed.chatModelId && SUPPORTED_CHAT_MODELS.some((m) => m.id === parsed.chatModelId)
          ? parsed.chatModelId
          : DEFAULT_SETTINGS.chatModelId,
      codingModelId:
        parsed.codingModelId && SUPPORTED_CODING_MODELS.some((m) => m.id === parsed.codingModelId)
          ? parsed.codingModelId
          : DEFAULT_SETTINGS.codingModelId,
      voiceId:
        parsed.voiceId && SUPPORTED_PIPER_VOICES.some((v) => v.id === parsed.voiceId)
          ? parsed.voiceId
          : DEFAULT_SETTINGS.voiceId,
      speechEnabled: loadSpeechChoice() ?? DEFAULT_SETTINGS.speechEnabled,
      sidebarOpen:
        typeof parsed.sidebarOpen === 'boolean'
          ? parsed.sidebarOpen
          : DEFAULT_SETTINGS.sidebarOpen,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

// Kept apart from the other settings: only the user's own choice is stored, so a phone that never
// chose keeps its default (off)
const SPEECH_CHOICE_KEY = 'chatty_speech';

/** The user's speech on/off choice, or null if they never made one. */
export function loadSpeechChoice(): boolean | null {
  try {
    const v = localStorage.getItem(SPEECH_CHOICE_KEY);
    return v === 'on' ? true : v === 'off' ? false : null;
  } catch {
    return null;
  }
}

// Kept apart from the other settings for the same reason: the settings blob always holds a model
// (any save of another setting writes the default one into it), so its presence says nothing about
// whether the user picked a model
const CHAT_MODEL_CHOICE_KEY = 'chatty_chat_model';

/** The chat model the user picked and saved, or null if they never chose one. */
/** Desktop defaults before this one: in settings saved before choices were recorded, not a pick */
const EARLIER_DEFAULTS = ['gemma-4-e2b-it-web'];

export function loadChatModelChoice(): string | null {
  try {
    const chosen = localStorage.getItem(CHAT_MODEL_CHOICE_KEY);
    if (chosen && SUPPORTED_CHAT_MODELS.some((m) => m.id === chosen)) return chosen;
    // Settings saved before the choice was recorded: a model other than the untouched default
    // can only have been picked by the user
    const raw = localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (raw) {
      const stored = (JSON.parse(raw) as Partial<ChattySettings>).chatModelId;
      if (stored && stored !== DEFAULT_SETTINGS.chatModelId && !EARLIER_DEFAULTS.includes(stored) && SUPPORTED_CHAT_MODELS.some((m) => m.id === stored)) {
        return stored;
      }
    }
  } catch {
    // Storage unavailable or unreadable: nothing was chosen
  }
  return null;
}

export function saveSettingsToStorage(settings: Partial<ChattySettings>): ChattySettings {
  if (typeof settings.chatModelId === 'string') {
    try {
      localStorage.setItem(CHAT_MODEL_CHOICE_KEY, settings.chatModelId);
    } catch {
      // Ignore storage errors in private browsing
    }
  }
  if (typeof settings.speechEnabled === 'boolean') {
    try {
      localStorage.setItem(SPEECH_CHOICE_KEY, settings.speechEnabled ? 'on' : 'off');
    } catch {
      // Ignore storage errors in private browsing
    }
  }
  const current = loadSettingsFromStorage();
  const updated: ChattySettings = {
    ...current,
    ...settings,
  };
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(updated));
    } catch {
      // Ignore storage errors in private browsing
    }
  }
  return updated;
}
