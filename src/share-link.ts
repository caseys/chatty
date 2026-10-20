/** Share links: a program's code carried in the URL hash, as base64url of its UTF-8 bytes. */
export const SHARE_MAX_CODE_BYTES = 8 * 1024;
const PREFIX = '#program=';

function toBase64Url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const b64 = text.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

/** The hash for a program, or null when it is empty or too long to share. */
export function encodeProgramHash(code: string): string | null {
  const bytes = new TextEncoder().encode(code);
  if (bytes.length === 0 || bytes.length > SHARE_MAX_CODE_BYTES) return null;
  return PREFIX + toBase64Url(bytes);
}

/** The program in a location hash, or null when there is none or it is malformed. */
export function decodeProgramHash(hash: string): string | null {
  if (!hash.startsWith(PREFIX)) return null;
  try {
    const code = new TextDecoder('utf-8', { fatal: true }).decode(fromBase64Url(hash.slice(PREFIX.length)));
    return code.trim() ? code : null;
  } catch {
    return null;
  }
}
