import { beforeEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PHONE_CHAT_MODEL_ID,
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  loadChatModelChoice,
  resolvePhoneChatModelId,
  saveSettingsToStorage,
} from '../src/core/settings.ts';

const GEMMA = 'gemma-4-e2b-it-web';

describe('phone default chat model', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('gives a phone that never chose a model Qwen3 0.6B, not the Gemma default', () => {
    expect(DEFAULT_SETTINGS.chatModelId).toBe(GEMMA); // desktop default is unchanged
    expect(loadChatModelChoice()).toBeNull();
    expect(resolvePhoneChatModelId(loadChatModelChoice())).toBe(DEFAULT_PHONE_CHAT_MODEL_ID);
    expect(DEFAULT_PHONE_CHAT_MODEL_ID).toBe('qwen3-0.6b');
  });

  it('does not count saving other settings as choosing a model', () => {
    // Every save writes the whole settings blob, default model included
    saveSettingsToStorage({ speechEnabled: true });
    saveSettingsToStorage({ sidebarOpen: true });
    saveSettingsToStorage({ voiceId: 'en_US-hfc_male-medium' });
    expect(JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY)!).chatModelId).toBe(GEMMA);
    expect(loadChatModelChoice()).toBeNull();
    expect(resolvePhoneChatModelId(loadChatModelChoice())).toBe('qwen3-0.6b');
  });

  it('keeps a phone-capable model the user picked, Gemma included', () => {
    saveSettingsToStorage({ chatModelId: GEMMA });
    expect(resolvePhoneChatModelId(loadChatModelChoice())).toBe(GEMMA);

    saveSettingsToStorage({ chatModelId: 'llama-3.2-1b' });
    expect(resolvePhoneChatModelId(loadChatModelChoice())).toBe('llama-3.2-1b');
  });

  it('replaces a saved model the phone cannot run', () => {
    saveSettingsToStorage({ chatModelId: 'qwen3-4b' });
    expect(resolvePhoneChatModelId(loadChatModelChoice())).toBe('qwen3-0.6b');
    expect(resolvePhoneChatModelId('gemma-4-e4b-it-web')).toBe('qwen3-0.6b');
  });

  it('reads a model from settings saved before choices were recorded', () => {
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ chatModelId: 'smollm2-360m' }));
    expect(loadChatModelChoice()).toBe('smollm2-360m');

    // The untouched default in an old blob can't be told from a pick, so a phone gets Qwen3
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({ chatModelId: GEMMA }));
    expect(loadChatModelChoice()).toBeNull();
  });

  it('ignores a stored model that no longer exists', () => {
    localStorage.setItem('chatty_chat_model', 'removed-model');
    expect(loadChatModelChoice()).toBeNull();
  });
});

describe('phone default by browser', () => {
  it('uses Gemma where Chrome reports enough memory, and Qwen3 on iPhone or low memory', async () => {
    const { phoneDefaultChatModelId, isAppleMobile, resolvePhoneChatModelId } = await import('../src/core/settings.ts');
    expect(phoneDefaultChatModelId(8, false)).toBe('gemma-4-e2b-it-web');
    expect(phoneDefaultChatModelId(4, false)).toBe('gemma-4-e2b-it-web');
    expect(phoneDefaultChatModelId(2, false)).toBe('qwen3-0.6b');
    expect(phoneDefaultChatModelId(undefined, false)).toBe('qwen3-0.6b');
    expect(phoneDefaultChatModelId(8, true)).toBe('qwen3-0.6b');
    expect(isAppleMobile('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)', 5)).toBe(true);
    expect(isAppleMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 5)).toBe(true); // iPad
    expect(isAppleMobile('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 0)).toBe(false);
    expect(isAppleMobile('Mozilla/5.0 (Linux; Android 14; Pixel 6)', 5)).toBe(false);
    // A saved pick still wins
    expect(resolvePhoneChatModelId('qwen3-0.6b', 'gemma-4-e2b-it-web')).toBe('qwen3-0.6b');
    expect(resolvePhoneChatModelId(null, 'gemma-4-e2b-it-web')).toBe('gemma-4-e2b-it-web');
  });
});
