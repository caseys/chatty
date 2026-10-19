// ============================================================================
// Application Settings & Model Preferences
// Supports selecting Chat Gemma model size, Coding Agent Gemma model size,
// and Piper ONNX Voice choice with localStorage & IndexedDB persistence.
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
}

/**
 * Chat models run with WebLLM (MLC, on WebGPU in a worker) instead of LiteRT; the only ones
 * phones get. Memory figures are WebLLM's own estimates, including a 4,096-token context.
 */
export interface LocalChatModel extends ModelOptionItem, WebLlmModelSpec {
  label: string;
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
  maxOutputTokens: 1536,
  phone,
});

export const LOCAL_CHAT_MODELS: ReadonlyArray<LocalChatModel> = [
  // Phone-sized (smallest memory first)
  local('smollm2-360m', 'SmolLM2 360M', 'SmolLM2-360M-Instruct-q4f16_1-MLC', 204, 376, 'Tiniest download, basic answers', true),
  local('llama-3.2-1b', 'Llama 3.2 1B', 'Llama-3.2-1B-Instruct-q4f16_1-MLC', 705, 879, 'Meta on-device model', true),
  local('qwen2.5-coder-0.5b', 'Qwen2.5-Coder 0.5B', 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC', 290, 945, 'Small model tuned for code', true),
  local('qwen2.5-0.5b', 'Qwen2.5 0.5B', 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 290, 945, 'Smallest download', true),
  { ...local('qwen3-0.6b', 'Qwen3 0.6B', 'Qwen3-0.6B-q4f16_1-MLC', 352, 1403, 'Newer general model', true), noThinking: true },
  { ...local('qwen3.5-0.8b', 'Qwen3.5 0.8B', 'Qwen3.5-0.8B-q4f16_1-MLC', 424, 1629, 'Newest small Qwen', true), noThinking: true },
  // Desktop (smallest memory first)
  local('qwen2.5-coder-1.5b', 'Qwen2.5-Coder 1.5B', 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', 880, 1630, 'Strong at JavaScript', false),
  local('smollm2-1.7b', 'SmolLM2 1.7B', 'SmolLM2-1.7B-Instruct-q4f16_1-MLC', 963, 1774, 'Hugging Face small model', false),
  { ...local('qwen3-1.7b', 'Qwen3 1.7B', 'Qwen3-1.7B-q4f16_1-MLC', 968, 2037, 'General model', false), noThinking: true },
  { ...local('qwen3.5-2b', 'Qwen3.5 2B', 'Qwen3.5-2B-q4f16_1-MLC', 1059, 2245, 'Newest Qwen, small', false), noThinking: true },
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

export function findLocalChatModel(id: string): LocalChatModel | undefined {
  return LOCAL_CHAT_MODELS.find((m) => m.id === id);
}

export const SUPPORTED_CHAT_MODELS: ReadonlyArray<ModelOptionItem> = [
  {
    id: 'gemma-4-e2b-it-web',
    name: 'Gemma 4 E2B (~1.95 GB, Fast, Phone: may crash)',
    description: 'Fast, efficient WebGPU inference',
    // Same Google LiteRT runtime as desktop; ~2 GB is near a phone tab's memory limit
    phone: true,
  },
  {
    id: 'gemma-4-e4b-it-web',
    name: 'Gemma 4 E4B (~2.89 GB, High Quality)',
    description: 'High quality, larger context reasoning',
  },
  ...LOCAL_CHAT_MODELS.map(({ id, name, description, phone }) => ({ id, name, description, phone })),
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
  chatModelId: 'gemma-4-e2b-it-web',
  codingModelId: 'gemma-4-e2b-it-web',
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

export function saveSettingsToStorage(settings: Partial<ChattySettings>): ChattySettings {
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
