// ============================================================================
// Application Settings & Model Preferences
// Supports selecting Chat Gemma model size, Coding Agent Gemma model size,
// and Piper ONNX Voice choice with localStorage & IndexedDB persistence.
// ============================================================================

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
