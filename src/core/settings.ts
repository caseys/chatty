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
  local('llama-3.2-1b', 'Llama 3.2 1B', 'Llama-3.2-1B-Instruct-q4f16_1-MLC', 705, 879, 'Meta on-device model', true),
  local('qwen2.5-coder-0.5b', 'Qwen2.5-Coder 0.5B', 'Qwen2.5-Coder-0.5B-Instruct-q4f16_1-MLC', 290, 945, 'Small model tuned for code', true),
  local('qwen2.5-0.5b', 'Qwen2.5 0.5B', 'Qwen2.5-0.5B-Instruct-q4f16_1-MLC', 290, 945, 'Smallest download', true),
  { ...local('qwen3-0.6b', 'Qwen3 0.6B', 'Qwen3-0.6B-q4f16_1-MLC', 352, 1403, 'Newer general model', true), noThinking: true },
  local('qwen2.5-coder-1.5b', 'Qwen2.5-Coder 1.5B', 'Qwen2.5-Coder-1.5B-Instruct-q4f16_1-MLC', 880, 1630, 'Strong at JavaScript', false),
  local('qwen2.5-coder-3b', 'Qwen2.5-Coder 3B', 'Qwen2.5-Coder-3B-Instruct-q4f16_1-MLC', 1748, 2505, 'Stronger at JavaScript', false),
  { ...local('qwen3-4b', 'Qwen3 4B', 'Qwen3-4B-q4f16_1-MLC', 2279, 3432, 'General model, good at code', false), noThinking: true },
  local('qwen2.5-coder-7b', 'Qwen2.5-Coder 7B', 'Qwen2.5-Coder-7B-Instruct-q4f16_1-MLC', 4296, 5107, 'Best at JavaScript, needs a strong GPU', false),
];

/** Phones start on Llama 3.2 1B: the smallest memory footprint, and it did best in testing */
export const DEFAULT_PHONE_CHAT_MODEL_ID = 'llama-3.2-1b';
/** Offered after a phone load dies (likely out of memory): the smallest memory footprint */
export const SMALLEST_PHONE_CHAT_MODEL_ID = 'llama-3.2-1b';

export function findLocalChatModel(id: string): LocalChatModel | undefined {
  return LOCAL_CHAT_MODELS.find((m) => m.id === id);
}

export const SUPPORTED_CHAT_MODELS: ReadonlyArray<ModelOptionItem> = [
  {
    id: 'gemma-4-e2b-it-web',
    name: 'Gemma 4 E2B (~1.95 GB, Fast)',
    description: 'Fast, efficient WebGPU inference',
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
    name: 'Piper US Female (Medium ONNX)',
    description: 'Natural female voice',
  },
  {
    id: 'en_US-hfc_male-medium',
    name: 'Piper US Male (Medium ONNX)',
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
