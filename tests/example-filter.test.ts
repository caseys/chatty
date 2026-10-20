import { describe, expect, it } from 'vitest';
import { examplesPrompt, promptRules } from '../src/core/orchestrator.ts';

describe('examples for small models', () => {
  it('shows only the examples a request matches', () => {
    const tip = examplesPrompt('Code a tip calculator app with a UI for the bill and tip %', true);
    expect(tip).toContain('zorbs to blips');
    expect(tip).toContain('Zibble');
    expect(tip).not.toContain('Zorblax');
    expect(tip).not.toContain('launch timer');
    expect(tip).not.toContain('okapi');
    expect(examplesPrompt('Play a slow piano song', true)).toContain('Zorblax');
    expect(examplesPrompt('Count down from 10 seconds', true)).toContain('launch timer');
  });

  it('names only the examples shown in the rules', () => {
    const rules = promptRules('Code a tip calculator', true);
    expect(rules).toContain('Zibble, zorbs, blips');
    expect(rules).not.toContain('Zorblax');
    expect(promptRules()).toContain('Zorblax');
  });

  it('shows every example unfiltered', () => {
    const all = examplesPrompt();
    for (const word of ['Zibble', 'Zorblax', 'zorbs', 'launch timer', 'okapi']) expect(all).toContain(word);
  });
});
