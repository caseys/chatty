// The note that points a request back at an earlier answer ("the second one"): never for a time
// ("a ten second countdown"), and never at the app's own greeting
import { describe, expect, it } from 'vitest';
import { ConversationMemoryStore as MemoryStore } from '../src/core/memory-store.ts';

const message = (role: 'user' | 'assistant', canonicalContent: string, id: string) => ({ id, turnId: id, role, canonicalContent, createdAt: Date.now() }) as never;

describe('reference notes', () => {
  it('reads "ten second" as a time, and never points at the app greeting (a live countdown request)', () => {
    const store = new MemoryStore();
    store.addMessage(message('assistant', 'Welcome back, what would you like to do with this browser?', 'g'));
    expect(store.resolveContextForQuery('Show a big ten second countdown on screen').resolvedReferencesNote).toBeNull();
    expect(store.resolveContextForQuery('Tell me about the second one').resolvedReferencesNote).toBeNull();
  });

  it('still points at a real earlier answer', () => {
    const store = new MemoryStore();
    store.addMessage(message('user', 'Give me two ideas', 'u'));
    store.addMessage(message('assistant', '1. A clock\n2. A dice roller', 'a'));
    expect(store.resolveContextForQuery('Make the second one').resolvedReferencesNote).toContain('A dice roller');
  });
});
