import { describe, expect, it } from 'vitest';
import { decodeProgramHash, encodeProgramHash, SHARE_MAX_CODE_BYTES } from '../src/share-link.ts';

describe('share link', () => {
  it('round-trips unicode code', () => {
    const code = 'speak("héllo ✓ 日本語 🎉");\nconst a = `x>>>?${1}`;';
    const hash = encodeProgramHash(code)!;
    expect(hash).toMatch(/^#program=[A-Za-z0-9_-]+$/);
    expect(decodeProgramHash(hash)).toBe(code);
  });
  it('refuses empty and over-long code', () => {
    expect(encodeProgramHash('')).toBeNull();
    expect(encodeProgramHash('a'.repeat(SHARE_MAX_CODE_BYTES + 1))).toBeNull();
    expect(encodeProgramHash('a'.repeat(SHARE_MAX_CODE_BYTES))).not.toBeNull();
  });
  it('ignores other or broken hashes', () => {
    expect(decodeProgramHash('')).toBeNull();
    expect(decodeProgramHash('#other=abc')).toBeNull();
    expect(decodeProgramHash('#program=%%%')).toBeNull();
    expect(decodeProgramHash('#program=_w')).toBeNull(); // invalid UTF-8
  });
});
