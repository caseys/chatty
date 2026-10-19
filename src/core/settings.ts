// ============================================================================
// Application Settings & Model Preferences
// Supports selecting Chat Gemma model size, Coding Agent Gemma model size,
// and Piper ONNX Voice choice with localStorage & IndexedDB persistence.
// ============================================================================

import type { OnnxModelSpec } from '../runtimes/onnx-llm-provider.ts';

export interface ChattySettings {
  chatModelId: string;
  codingModelId: string;
  voiceId: string;
  sidebarOpen: boolean;
}

export interface ModelOptionItem {
  id: string;
  name: string;
  description: string;
  /** Small enough for a phone browser tab */
  phone?: boolean;
}

/** Chat models run with Transformers.js (ONNX on WebGPU) instead of LiteRT; the only ones phones get. */
export interface OnnxChatModel extends ModelOptionItem, OnnxModelSpec {
  label: string;
  sizeBytes: number;
}

export const ONNX_CHAT_MODELS: ReadonlyArray<OnnxChatModel> = [
  {
    id: 'qwen2.5-coder-0.5b',
    label: 'Qwen2.5-Coder 0.5B',
    name: 'Qwen2.5-Coder 0.5B (~555 MB, Phone)',
    description: 'Smallest model tuned for JavaScript',
    repo: 'onnx-community/Qwen2.5-Coder-0.5B-Instruct',
    dtype: 'q4f16',
    contextLimit: 8192,
    maxOutputTokens: 1536,
    sizeBytes: 555_000_000,
    phone: true,
  },
  {
    id: 'qwen3-0.6b',
    label: 'Qwen3 0.6B',
    name: 'Qwen3 0.6B (~570 MB, Phone)',
    description: 'Newer general model that also codes',
    repo: 'onnx-community/Qwen3-0.6B-ONNX',
    dtype: 'q4f16',
    contextLimit: 8192,
    maxOutputTokens: 1536,
    sizeBytes: 570_000_000,
    phone: true,
    // Answer directly instead of writing a <think> block first
    templateOptions: { enable_thinking: false },
  },
  {
    id: 'qwen2.5-0.5b',
    label: 'Qwen2.5 0.5B',
    name: 'Qwen2.5 0.5B (~483 MB, Phone)',
    description: 'Smallest general model',
    repo: 'onnx-community/Qwen2.5-0.5B-Instruct',
    dtype: 'q4f16',
    contextLimit: 8192,
    maxOutputTokens: 1536,
    sizeBytes: 483_000_000,
    phone: true,
  },
  {
    id: 'lfm2-1.2b',
    label: 'LFM2 1.2B',
    name: 'LFM2 1.2B (~760 MB, Phone)',
    description: 'Liquid AI on-device model',
    repo: 'onnx-community/LFM2-1.2B-ONNX',
    dtype: 'q4f16',
    contextLimit: 8192,
    maxOutputTokens: 1536,
    sizeBytes: 760_000_000,
    phone: true,
  },
  {
    id: 'gemma-3-1b',
    label: 'Gemma 3 1B',
    name: 'Gemma 3 1B (~763 MB, Phone)',
    description: 'Google on-device chat model',
    repo: 'onnx-community/gemma-3-1b-it-ONNX',
    dtype: 'q4f16',
    contextLimit: 8192,
    maxOutputTokens: 1536,
    sizeBytes: 763_000_000,
    phone: true,
  },
  {
    id: 'qwen2.5-coder-1.5b',
    label: 'Qwen2.5-Coder 1.5B',
    name: 'Qwen2.5-Coder 1.5B (~1.34 GB, Code-focused)',
    description: 'Strong at JavaScript, plainer conversation',
    repo: 'onnx-community/Qwen2.5-Coder-1.5B-Instruct',
    dtype: 'q4f16',
    contextLimit: 8192,
    maxOutputTokens: 1536,
    sizeBytes: 1_344_000_000,
  },
];

export const DEFAULT_PHONE_CHAT_MODEL_ID = 'qwen2.5-0.5b';
/** Tried after a phone load dies (likely out of memory) */
export const SMALLEST_PHONE_CHAT_MODEL_ID = 'qwen2.5-0.5b';

export function findOnnxChatModel(id: string): OnnxChatModel | undefined {
  return ONNX_CHAT_MODELS.find((m) => m.id === id);
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
  ...ONNX_CHAT_MODELS.map(({ id, name, description, phone }) => ({ id, name, description, phone })),
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
      sidebarOpen:
        typeof parsed.sidebarOpen === 'boolean'
          ? parsed.sidebarOpen
          : DEFAULT_SETTINGS.sidebarOpen,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettingsToStorage(settings: Partial<ChattySettings>): ChattySettings {
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
