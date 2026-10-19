// ============================================================================
// 3-Tier Conversation Memory & Selective Context Resolution
// (Addendum Section 5)
// ============================================================================

import type {
  ConversationMessage,
  ConversationSummary,
  LongTermMemoryItem,
} from '../types/index.ts';
// Size estimates use the same compact form the prompt uses (past programs summarized)
import { compactAssistantContent } from './history-format.ts';

export interface CandidateMemoryProposal {
  id: string;
  key: string;
  value: string;
  category: 'preference' | 'fact' | 'constraint';
  sourceTurnId: string;
  rawStatement: string;
}

export interface ResolvedTurnContext {
  workingMessages: ConversationMessage[];
  conversationSummary: ConversationSummary | null;
  relevantMemories: LongTermMemoryItem[];
  resolvedReferencesNote: string | null;
  estimatedTokens: number;
}

export class ConversationMemoryStore {
  private messages: ConversationMessage[] = [];
  private summary: ConversationSummary | null = null;
  private longTermMemories = new Map<string, LongTermMemoryItem>();
  private pendingProposals = new Map<string, CandidateMemoryProposal>();

  private readonly maxVerbatimTurns: number;
  private readonly defaultTokenBudget: number;

  constructor(options?: { maxVerbatimTurns?: number; defaultTokenBudget?: number }) {
    this.maxVerbatimTurns = options?.maxVerbatimTurns ?? 8; // 8 messages = 4 user/assistant pairs
    this.defaultTokenBudget = options?.defaultTokenBudget ?? 2048;
  }

  // --------------------------------------------------------------------------
  // Layer 1: Working Context (Recent Verbatim Turns)
  // --------------------------------------------------------------------------

  addMessage(message: ConversationMessage): void {
    this.messages.push(message);
    if (message.role === 'user') {
      this.detectCandidateMemoryProposal(message);
    }
    this.compactIfNecessary();
  }

  updateMessage(id: string, patch: Partial<ConversationMessage>): void {
    const idx = this.messages.findIndex((m) => m.id === id);
    if (idx !== -1) {
      this.messages[idx] = { ...this.messages[idx], ...patch };
    }
  }

  getMessages(): ReadonlyArray<ConversationMessage> {
    return [...this.messages];
  }

  clearConversation(): void {
    this.messages = [];
    this.summary = null;
  }

  loadConversation(messages: ConversationMessage[], summary: ConversationSummary | null): void {
    this.messages = [...messages];
    this.summary = summary ? { ...summary } : null;
  }

  clearAllMemories(): void {
    this.longTermMemories.clear();
    this.pendingProposals.clear();
  }

  compactWithSummary(summary: ConversationSummary): void {
    this.messages = [];
    this.summary = summary;
  }

  // --------------------------------------------------------------------------
  // Layer 2: Conversation Summary (Decisions, Entities, Constraints, Questions)
  // --------------------------------------------------------------------------

  getSummary(): ConversationSummary | null {
    return this.summary ? { ...this.summary } : null;
  }

  setSummary(summary: ConversationSummary | null): void {
    this.summary = summary;
  }

  updateSummaryTitle(title: string): void {
    if (this.summary) {
      this.summary.title = title;
    }
  }

  /**
   * Summarizes older turns when conversation exceeds working context budget.
   * Preserves decisions, unresolved questions, named entities, and constraints.
   */
  compactIfNecessary(customMaxTurns?: number): ConversationSummary | null {
    const limit = customMaxTurns ?? this.maxVerbatimTurns;
    if (this.messages.length <= limit) {
      return this.summary;
    }

    const toSummarizeCount = this.messages.length - limit;
    const olderMessages = this.messages.slice(0, toSummarizeCount);

    const decisions = new Set<string>(this.summary?.decisions ?? []);
    const unresolvedQuestions = new Set<string>(this.summary?.unresolvedQuestions ?? []);
    const namedEntities: Record<string, string> = { ...(this.summary?.namedEntities ?? {}) };
    const constraints = new Set<string>(this.summary?.constraints ?? []);

    for (let i = 0; i < olderMessages.length; i++) {
      const msg = olderMessages[i];
      const text = msg.canonicalContent;

      if (msg.role === 'user') {
        // Extract constraints (e.g., "don't", "must", "only", "under $X", "without")
        const constraintMatches = text.match(
          /\b(?:must|only|never|don't|do not|without|under \$?\d+|at most \d+|keep it [^.,!?]+|no more than [^.,!?]+)/gi
        );
        if (constraintMatches) {
          for (const c of constraintMatches) {
            constraints.add(c.trim());
          }
        }

        // Extract decisions ("I chose X", "Let's go with X", "We decided on X")
        const decisionMatch = text.match(
          /\b(?:i(?:'ll)?\s+(?:choose|pick|take|go with)|let's\s+(?:use|go with|do)|we\s+decided\s+on)\s+([^.!?]+)/i
        );
        if (decisionMatch) {
          decisions.add(decisionMatch[0].trim());
        }

        // Extract named entities (capitalized multi-word or key topic terms)
        const entityMatch = text.match(/\b(?:project|called|named|visiting|using)\s+([A-Z][A-Za-z0-9_-]+(?:\s+[A-Z][A-Za-z0-9_-]+)*)/);
        if (entityMatch) {
          namedEntities[entityMatch[1]] = text.slice(0, 80);
        }

        // Check if user asked a question that wasn't answered or was interrupted next
        if (text.includes('?')) {
          const nextMsg = olderMessages[i + 1];
          if (!nextMsg || nextMsg.interrupted) {
            unresolvedQuestions.add(text);
          } else {
            unresolvedQuestions.delete(text);
          }
        }
      } else if (msg.role === 'assistant' && !msg.interrupted) {
        // If assistant answered, clear previous unresolved questions if addressed
        if (unresolvedQuestions.size > 0 && text.length > 20) {
          unresolvedQuestions.clear();
        }
      }
    }

    const totalCovered = (this.summary?.coveredTurnCount ?? 0) + olderMessages.length;
    const lastCoveredTurnId = olderMessages[olderMessages.length - 1]?.turnId ?? '';

    const summaryParts: string[] = [];
    if (Object.keys(namedEntities).length > 0) {
      summaryParts.push(`Entities: ${Object.keys(namedEntities).join(', ')}`);
    }
    if (decisions.size > 0) {
      summaryParts.push(`Decisions: ${Array.from(decisions).join('; ')}`);
    }
    if (constraints.size > 0) {
      summaryParts.push(`Constraints: ${Array.from(constraints).join('; ')}`);
    }
    if (unresolvedQuestions.size > 0) {
      summaryParts.push(`Open questions: ${Array.from(unresolvedQuestions).join('; ')}`);
    }
    if (summaryParts.length === 0) {
      const briefTopics = olderMessages
        .filter((m) => m.role === 'user')
        .map((m) => m.canonicalContent.slice(0, 60))
        .slice(-3);
      summaryParts.push(`Prior topics discussed: ${briefTopics.join(' | ')}`);
    }

    // Never discard an LLM-authored summary: heuristic summaries are tagged `sum_h_`,
    // so anything else is preserved verbatim and heuristic notes are appended to it.
    // The heuristic section is cumulative, so it replaces (not stacks on) any prior heuristic section.
    const heuristicMarker = '\n[Heuristic notes] ';
    const priorLlmFull =
      this.summary && !this.summary.id.startsWith('sum_h_') ? this.summary.summaryText : '';
    const markerIdx = priorLlmFull.indexOf(heuristicMarker);
    const priorLlmText = markerIdx === -1 ? priorLlmFull : priorLlmFull.slice(0, markerIdx);
    const heuristicText = summaryParts.join('. ');

    this.summary = {
      id: priorLlmText && this.summary ? this.summary.id : `sum_h_${Date.now()}`,
      title: this.summary?.title,
      updatedAt: Date.now(),
      coveredTurnCount: totalCovered,
      lastCoveredTurnId,
      summaryText: priorLlmText ? `${priorLlmText}${heuristicMarker}${heuristicText}` : heuristicText,
      decisions: Array.from(decisions),
      unresolvedQuestions: Array.from(unresolvedQuestions),
      namedEntities,
      constraints: Array.from(constraints),
    };

    // Trim summarized messages from active verbatim list
    this.messages = this.messages.slice(toSummarizeCount);
    return this.summary;
  }

  // --------------------------------------------------------------------------
  // Layer 3: Long-Term Local Memory (Explicit User Approval & Precedence)
  // --------------------------------------------------------------------------

  /**
   * Explicitly adds or updates an approved long-term memory item.
   * Newer statements with the same key override older ones (precedence rule).
   */
  upsertApprovedMemory(
    key: string,
    value: string,
    category: 'preference' | 'fact' | 'constraint' = 'preference',
    sourceTurnId?: string
  ): LongTermMemoryItem {
    const normalizedKey = key.trim().toLowerCase();
    const existing = this.longTermMemories.get(normalizedKey);
    const now = Date.now();
    const item: LongTermMemoryItem = {
      id: existing?.id ?? `mem_${now}_${Math.random().toString(36).slice(2, 6)}`,
      key: normalizedKey,
      value: value.trim(),
      category,
      approvedByUser: true,
      sourceTurnId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.longTermMemories.set(normalizedKey, item);
    return item;
  }

  deleteMemory(idOrKey: string): boolean {
    const normalized = idOrKey.trim().toLowerCase();
    if (this.longTermMemories.has(normalized)) {
      return this.longTermMemories.delete(normalized);
    }
    for (const [k, v] of this.longTermMemories.entries()) {
      if (v.id === idOrKey) {
        return this.longTermMemories.delete(k);
      }
    }
    return false;
  }

  getAllMemories(): LongTermMemoryItem[] {
    return Array.from(this.longTermMemories.values()).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  loadMemories(items: LongTermMemoryItem[]): void {
    this.longTermMemories.clear();
    for (const item of items) {
      if (item.approvedByUser) {
        this.longTermMemories.set(item.key.toLowerCase(), item);
      }
    }
  }

  getPendingProposals(): CandidateMemoryProposal[] {
    return Array.from(this.pendingProposals.values());
  }

  approveProposal(proposalId: string): LongTermMemoryItem | null {
    const proposal = this.pendingProposals.get(proposalId);
    if (!proposal) return null;
    this.pendingProposals.delete(proposalId);
    return this.upsertApprovedMemory(
      proposal.key,
      proposal.value,
      proposal.category,
      proposal.sourceTurnId
    );
  }

  dismissProposal(proposalId: string): void {
    this.pendingProposals.delete(proposalId);
  }

  private detectCandidateMemoryProposal(message: ConversationMessage): void {
    const text = message.canonicalContent;
    // Only propose durable preferences on explicit statements ("Remember that I prefer...", "My name is...", "I am allergic to...")
    // Never auto-commit without approval unless user explicitly commands "remember that..."
    const explicitPrefer = text.match(
      /\b(?:always\s+remember\s+that\s+i\s+prefer|i\s+always\s+prefer|my\s+preferred\s+([a-z\s]+)\s+is)\s+([^.!?]+)/i
    );
    if (explicitPrefer) {
      const key = explicitPrefer[1] ? `preferred_${explicitPrefer[1].trim()}` : 'user_preference';
      const val = (explicitPrefer[2] ?? explicitPrefer[1]).trim();
      const id = `prop_${message.turnId}`;
      this.pendingProposals.set(id, {
        id,
        key,
        value: val,
        category: 'preference',
        sourceTurnId: message.turnId,
        rawStatement: text,
      });
    }
  }

  // --------------------------------------------------------------------------
  // Selective Retrieval & Reference Resolution (Addendum Section 3.2 & 5)
  // --------------------------------------------------------------------------

  resolveContextForQuery(userQuery: string, tokenBudget = this.defaultTokenBudget): ResolvedTurnContext {
    const queryWords = new Set(
      userQuery
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length > 2)
    );

    // 1. Selectively retrieve relevant long-term memories (ranked by keyword overlap & recency)
    const allMemories = this.getAllMemories();
    const scoredMemories = allMemories.map((mem) => {
      const memText = `${mem.key} ${mem.value}`.toLowerCase();
      let score = 0;
      for (const word of queryWords) {
        if (memText.includes(word)) score += 3;
      }
      // Always include general response style constraints if any
      if (mem.category === 'constraint' || mem.key.includes('response') || mem.key.includes('name')) {
        score += 1;
      }
      return { mem, score };
    });

    const relevantMemories = scoredMemories
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score || b.mem.updatedAt - a.mem.updatedAt)
      .slice(0, 5)
      .map((s) => s.mem);

    // 2. Reference resolution ("that one", "the second option", "it", "they", "the first one")
    const resolvedReferencesNote = this.resolveAnaphoraAndOptions(userQuery);

    // 3. Respect token budget when selecting verbatim working messages
    let usedTokens = this.estimateTokens(userQuery) + 120; // System prompt + overhead
    if (this.summary) {
      usedTokens += this.estimateTokens(this.summary.summaryText);
    }
    for (const mem of relevantMemories) {
      usedTokens += this.estimateTokens(`${mem.key}: ${mem.value}`);
    }

    const selectedMessages: ConversationMessage[] = [];
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      const textToEstimate =
        msg.role === 'assistant' ? compactAssistantContent(msg) : msg.canonicalContent;
      const msgTokens = this.estimateTokens(textToEstimate);
      if (usedTokens + msgTokens > tokenBudget && selectedMessages.length >= 2) {
        break;
      }
      selectedMessages.unshift(msg);
      usedTokens += msgTokens;
    }

    return {
      workingMessages: selectedMessages,
      conversationSummary: this.summary,
      relevantMemories,
      resolvedReferencesNote,
      estimatedTokens: usedTokens,
    };
  }

  private resolveAnaphoraAndOptions(userQuery: string): string | null {
    const lower = userQuery.toLowerCase();
    const hasOrdinalRef = /\b(first|second|third|1st|2nd|3rd|last|former|latter)\s+(one|option|choice|item|point)?\b/i.test(
      lower
    );
    const hasPronounRef = /\b(that one|this one|what about it|tell me more about that|how much is it|compare them)\b/i.test(
      lower
    );

    if (!hasOrdinalRef && !hasPronounRef) {
      return null;
    }

    // Look back at the most recent assistant message for numbered/bulleted items or entities
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const msg = this.messages[i];
      if (msg.role === 'assistant') {
        const content = msg.canonicalContent;
        // Extract list options if present
        const listItems = content
          .split(/\n|(?:^|\s)(?:\d+\.|[-•*])\s+/)
          .map((s) => s.trim())
          .filter((s) => s.length > 3);

        if (listItems.length >= 2) {
          if (/\b(first|1st|former)\b/i.test(lower)) {
            return `User reference "${userQuery}" likely refers to option 1: "${listItems[0].slice(0, 100)}"`;
          }
          if (/\b(second|2nd|latter)\b/i.test(lower) && listItems[1]) {
            return `User reference "${userQuery}" likely refers to option 2: "${listItems[1].slice(0, 100)}"`;
          }
          if (/\b(third|3rd)\b/i.test(lower) && listItems[2]) {
            return `User reference "${userQuery}" likely refers to option 3: "${listItems[2].slice(0, 100)}"`;
          }
          if (/\b(last)\b/i.test(lower)) {
            return `User reference "${userQuery}" likely refers to the last option: "${listItems[listItems.length - 1].slice(0, 100)}"`;
          }
        }

        return `Prior assistant context for reference resolution: "${content.slice(0, 180)}"`;
      }
    }

    return null;
  }

  estimateTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  getCurrentContextTokens(incomingQuery = ''): number {
    const hasContent =
      this.messages.length > 0 || this.summary !== null || this.longTermMemories.size > 0;
    if (!hasContent && !incomingQuery) {
      return 0;
    }
    let tokens = 150; // System prompt baseline overhead when conversation is active
    if (this.summary?.summaryText) {
      tokens += this.estimateTokens(this.summary.summaryText);
    }
    for (const mem of this.getAllMemories()) {
      tokens += this.estimateTokens(`${mem.key}: ${mem.value}`);
    }
    for (const msg of this.messages) {
      const textToEstimate =
        msg.role === 'assistant' ? compactAssistantContent(msg) : msg.canonicalContent;
      tokens += this.estimateTokens(textToEstimate);
    }
    if (incomingQuery) {
      tokens += this.estimateTokens(incomingQuery);
    }
    return tokens;
  }

  isContextCompactionNeeded(contextLimit: number, incomingQuery = '', thresholdRatio = 0.85): boolean {
    if (this.messages.length === 0) return false;
    const tokens = this.getCurrentContextTokens(incomingQuery);
    return tokens >= Math.floor(contextLimit * thresholdRatio);
  }
}
