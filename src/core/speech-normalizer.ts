// ============================================================================
// Speech-Aware Generation, Transcript Normalization, & Phrase Segmenter
// (Addendum Sections 3.1, 3.6, and 7)
// ============================================================================

const COMMON_ABBREVIATIONS = new Set([
  'mr.',
  'mrs.',
  'ms.',
  'dr.',
  'prof.',
  'sr.',
  'jr.',
  'st.',
  'ave.',
  'blvd.',
  'rd.',
  'vs.',
  'etc.',
  'e.g.',
  'i.e.',
  'fig.',
  'inc.',
  'ltd.',
  'co.',
  'corp.',
  'jan.',
  'feb.',
  'mar.',
  'apr.',
  'jun.',
  'jul.',
  'aug.',
  'sep.',
  'sept.',
  'oct.',
  'nov.',
  'dec.',
  'u.s.',
  'u.k.',
]);

const SPOKEN_ABBREVIATION_MAP: Array<[RegExp, string]> = [
  [/\bMr\./g, 'Mister'],
  [/\bMrs\./g, 'Missus'],
  [/\bMs\./g, 'Miz'],
  [/\bDr\./g, 'Doctor'],
  [/\bProf\./g, 'Professor'],
  [/\bSr\./g, 'Senior'],
  [/\bJr\./g, 'Junior'],
  [/\bSt\.\s+(?=[A-Z])/g, 'Saint '],
  [/\bvs\./gi, 'versus'],
  [/\be\.g\./gi, 'for example'],
  [/\bi\.e\./gi, 'that is'],
  [/\betc\./gi, 'et cetera'],
  [/\bapprox\./gi, 'approximately'],
  [/\bAPI\b/g, 'A P I'],
  [/\bUI\b/g, 'U I'],
  [/\bURL\b/g, 'U R L'],
  [/\bCPU\b/g, 'C P U'],
  [/\bGPU\b/g, 'G P U'],
  [/\bLLM\b/g, 'L L M'],
  [/\bSTT\b/g, 'S T T'],
  [/\bTTS\b/g, 'T T S'],
  [/\bWebGPU\b/gi, 'Web G P U'],
  [/\bWASM\b/g, 'wasm'],
  [/\bOPFS\b/g, 'O P F S'],
  [/\b(\d+)\s*%/g, '$1 percent'],
  [/\$(\d+(?:\.\d+)?)/g, '$1 dollars'],
  [/\b(\d+)\s*ms\b/g, '$1 milliseconds'],
  [/\b(\d+)\s*kHz\b/gi, '$1 kilohertz'],
  [/\b(\d+)\s*MB\b/g, '$1 megabytes'],
  [/\b(\d+)\s*GB\b/g, '$1 gigabytes'],
];

/**
 * Conservatively normalizes STT output without altering user meaning:
 * - Collapses duplicate spaces and common ASR artifacts (e.g. [BLANK_AUDIO])
 * - Capitalizes first letter and standalone 'i'
 * - Ensures terminal punctuation if missing
 */
export function normalizeUserTranscript(raw: string): {
  rawTranscript: string;
  normalized: string;
} {
  const rawTranscript = raw;
  let cleaned = raw
    .replace(/\[(?:BLANK_AUDIO|MUSIC|NOISE|INAUDIBLE|SILENCE)\]/gi, '')
    .replace(/\((?:silence|music|noise|laughter)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim();

  if (!cleaned) {
    return { rawTranscript, normalized: '' };
  }

  // Remove immediate stuttered repeated filler words at start ("uh uh", "um um")
  cleaned = cleaned.replace(/^(?:uh+|um+)\s+(?:uh+|um+)\s+/i, '');

  // Capitalize standalone pronoun 'i' and contractions "i'm", "i'll", "i've", "i'd"
  cleaned = cleaned.replace(/\bi(?=['’](?:m|ll|ve|d)\b|\b)/g, 'I');

  // Capitalize first character
  cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);

  // Add terminal punctuation if missing
  if (!/[.!?]$/.test(cleaned)) {
    const isQuestion =
      /^(?:who|what|where|when|why|how|can|could|would|should|is|are|do|does|did|will|may)\b/i.test(
        cleaned
      );
    cleaned += isQuestion ? '?' : '.';
  }

  return { rawTranscript, normalized: cleaned };
}

/**
 * Strips all tool call markers, special tokens, and syntax blocks completely from text.
 * Ensures tokens like `<|tool_call>`, `<tool_call|>`, `call:...`, or JSON blocks never leak
 * into user-facing conversational text or TTS audio.
 */
export function stripToolCallMarkup(text: string): string {
  if (!text) return '';
  return text
    // Remove fenced tool_call or json blocks
    .replace(/```(?:tool_call|json)\s*\n[\s\S]*?(?:\n```|$)/gi, '')
    // Remove <|tool_call>...<tool_call|> or variations
    .replace(/<\|tool_call[\s\S]*?(?:<tool_call\|>|<\/\|tool_call>|<\|tool_call_end\|>|<\|tool_call\|>|$)/gi, '')
    .replace(/<tool_call[\s\S]*?(?:<\/tool_call>|<tool_call\|>|$)/gi, '')
    // Remove standalone special tool tokens / tags (including empty pairs like <|tool_call><tool_call|>)
    .replace(/<\|tool_call(?:_end)?\|?>/gi, '')
    .replace(/<\/\|?tool_call\|?>/gi, '')
    .replace(/<tool_call\|?>/gi, '')
    .replace(/<\/tool_call>/gi, '')
    .replace(/<start_function_call>[\s\S]*?(?:<end_function_call>|$)/gi, '')
    .replace(/<start_function_call>/gi, '')
    .replace(/<end_function_call>/gi, '')
    // Remove call:toolName{...}
    .replace(/call:\w+\s*\{[\s\S]*?\}/gi, '')
    // Remove raw JSON tool call objects
    .replace(/\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*\{[\s\S]*?\}\s*\}/gi, '')
    .trim();
}

/**
 * Converts canonical markdown/text into natural speech-ready text for TTS
 * without modifying the canonical text displayed in the UI.
 */
export function normalizeTextForSpeech(canonicalText: string): string {
  let speech = stripToolCallMarkup(canonicalText);

  // Strip markdown formatting while preserving words
  speech = speech
    .replace(/```[\s\S]*?```/g, ' code block omitted ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_]+)_/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*_]{3,}\s*$/gm, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*(\d+)\.\s+/gm, '$1, ');

  for (const [pattern, replacement] of SPOKEN_ABBREVIATION_MAP) {
    speech = speech.replace(pattern, replacement);
  }

  // Format decimals like 3.14 -> "3 point 1 4" so TTS doesn't pause on the period
  speech = speech.replace(/\b(\d+)\.(\d+)\b/g, (_match, intPart: string, decPart: string) => {
    const digits = decPart.split('').join(' ');
    return `${intPart} point ${digits}`;
  });

  const normalized = speech.replace(/\s+/g, ' ').trim();
  if (!/[A-Za-z0-9]/.test(normalized)) {
    return '';
  }
  return normalized;
}

/**
 * Incremental phrase boundary detector that buffers streamed LLM tokens and emits
 * natural speech-ready phrases without splitting abbreviations (e.g., "Dr.", "e.g.")
 * or numbers (e.g., "3.14").
 */
export class IncrementalPhraseSegmenter {
  private buffer = '';
  private emittedCount = 0;
  private readonly minPhraseChars: number;
  private readonly clauseSplitChars: number;
  private readonly firstPhraseMinChars: number;
  private readonly firstPhraseClauseChars: number;

  constructor(options?: {
    minPhraseChars?: number;
    clauseSplitChars?: number;
    firstPhraseMinChars?: number;
    firstPhraseClauseChars?: number;
  }) {
    this.minPhraseChars = options?.minPhraseChars ?? 20;
    this.clauseSplitChars = options?.clauseSplitChars ?? 180;
    this.firstPhraseMinChars = options?.firstPhraseMinChars ?? options?.minPhraseChars ?? 12;
    this.firstPhraseClauseChars =
      options?.firstPhraseClauseChars ?? options?.clauseSplitChars ?? 96;
  }

  /**
   * Appends a token chunk and returns any completed canonical phrases.
   */
  push(chunk: string): string[] {
    this.buffer += chunk;
    const phrases: string[] = [];

    while (true) {
      const splitIdx = this.findSafeBoundary(this.buffer);
      if (splitIdx === -1) break;

      const candidate = this.buffer.slice(0, splitIdx).trim();
      this.buffer = this.buffer.slice(splitIdx).trimStart();
      if (candidate.length > 0) {
        this.emittedCount++;
        phrases.push(candidate);
      }
    }

    return phrases;
  }

  /**
   * Flushes any remaining buffered text at the end of a turn.
   */
  flush(): string[] {
    const remaining = this.buffer.trim();
    this.buffer = '';
    if (remaining) {
      this.emittedCount++;
      return [remaining];
    }
    return [];
  }

  reset(): void {
    this.buffer = '';
    this.emittedCount = 0;
  }

  getPendingBuffer(): string {
    return this.buffer;
  }

  private findSafeBoundary(text: string): number {
    const activeMinPhraseChars =
      this.emittedCount === 0 ? this.firstPhraseMinChars : this.minPhraseChars;
    const activeClauseChars =
      this.emittedCount === 0 ? this.firstPhraseClauseChars : this.clauseSplitChars;

    for (let i = 0; i < text.length; i++) {
      const ch = text[i];

      // Newline boundary
      if (ch === '\n' && i >= activeMinPhraseChars) {
        return i + 1;
      }

      // Strong sentence boundaries: . ! ?
      if (ch === '.' || ch === '!' || ch === '?') {
        // Must have a following character (space or newline) to confirm it's not mid-token (like 3.14)
        const nextChar = text[i + 1];
        if (!nextChar || !/\s/.test(nextChar)) {
          continue;
        }

        if (i + 1 < activeMinPhraseChars) {
          continue;
        }

        if (ch === '.') {
          // Check if period is part of a decimal number
          const prevChar = i > 0 ? text[i - 1] : '';
          if (/\d/.test(prevChar) && text[i + 1] && /\d/.test(text[i + 1])) {
            continue;
          }

          const prefix = text.slice(0, i + 1);

          // Avoid splitting on numbered list items like "1. " or "Step 1. "
          if (
            /^\s*\d{1,3}\.$/.test(prefix) ||
            /(?:^|\s)(?:step|item|part|no|number|fig|figure|sec|section)\s+\d{1,3}\.$/i.test(prefix)
          ) {
            continue;
          }

          // Check if period ends a known abbreviation (e.g., "Dr.", "Mr.", "e.g.")
          const lastWordMatch = prefix.match(/([A-Za-z.]+)$/);
          if (lastWordMatch) {
            const lastWord = lastWordMatch[1].toLowerCase();
            if (COMMON_ABBREVIATIONS.has(lastWord)) {
              continue;
            }
            // Single capital initial like "J. K. Rowling"
            if (/^[a-z]\.$/i.test(lastWord)) {
              continue;
            }
          }
        }

        return i + 1;
      }

      // Secondary clause boundaries (; : , — –) only when a sentence is genuinely long
      if (
        (ch === ';' || ch === ':' || ch === ',' || ch === '—' || ch === '–') &&
        i >= activeClauseChars
      ) {
        const nextChar = text[i + 1];
        if (nextChar && /\s/.test(nextChar)) {
          return i + 1;
        }
      }
    }

    return -1;
  }
}
