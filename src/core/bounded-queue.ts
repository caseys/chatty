// ============================================================================
// Bounded Queue & Resource Scheduler with Backpressure and Turn Isolation
// ============================================================================

export interface QueueItem<T> {
  id: string;
  turnId: string;
  sequence: number;
  priority: number; // Higher number = higher priority
  payload: T;
  enqueuedAt: number;
}

export interface BoundedQueueOptions {
  maxSize: number;
  highWaterMark?: number;
  lowWaterMark?: number;
  dropPolicy?: 'drop_oldest' | 'reject_new';
  onBackpressureChange?: (paused: boolean) => void;
}

export class BoundedQueue<T> {
  private items: QueueItem<T>[] = [];
  private readonly maxSize: number;
  private readonly highWaterMark: number;
  private readonly lowWaterMark: number;
  private readonly dropPolicy: 'drop_oldest' | 'reject_new';
  private readonly onBackpressureChange?: (paused: boolean) => void;
  private isPaused = false;

  constructor(options: BoundedQueueOptions) {
    this.maxSize = Math.max(1, options.maxSize);
    this.highWaterMark = options.highWaterMark ?? Math.ceil(this.maxSize * 0.8);
    this.lowWaterMark = options.lowWaterMark ?? Math.floor(this.maxSize * 0.4);
    this.dropPolicy = options.dropPolicy ?? 'reject_new';
    this.onBackpressureChange = options.onBackpressureChange;
  }

  get size(): number {
    return this.items.length;
  }

  get backpressured(): boolean {
    return this.isPaused;
  }

  enqueue(item: QueueItem<T>): boolean {
    if (this.items.length >= this.maxSize) {
      if (this.dropPolicy === 'drop_oldest') {
        this.items.shift();
      } else {
        this.updateBackpressure();
        return false;
      }
    }

    // Insert maintaining priority order (descending priority, then ascending sequence)
    let inserted = false;
    for (let i = 0; i < this.items.length; i++) {
      const existing = this.items[i];
      if (
        item.priority > existing.priority ||
        (item.priority === existing.priority && item.sequence < existing.sequence)
      ) {
        this.items.splice(i, 0, item);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.items.push(item);
    }

    this.updateBackpressure();
    return true;
  }

  dequeue(): QueueItem<T> | undefined {
    const item = this.items.shift();
    this.updateBackpressure();
    return item;
  }

  peek(): QueueItem<T> | undefined {
    return this.items[0];
  }

  /**
   * Removes all queued items that do not belong to the active turnId,
   * or removes all items belonging to a canceled turnId.
   */
  cancelTurn(turnId: string): number {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.turnId !== turnId);
    const removed = before - this.items.length;
    this.updateBackpressure();
    return removed;
  }

  /**
   * Purges all items except those matching the specified activeTurnId.
   */
  retainOnlyTurn(activeTurnId: string): number {
    const before = this.items.length;
    this.items = this.items.filter((item) => item.turnId === activeTurnId);
    const removed = before - this.items.length;
    this.updateBackpressure();
    return removed;
  }

  clear(): void {
    this.items = [];
    this.updateBackpressure();
  }

  toArray(): ReadonlyArray<QueueItem<T>> {
    return [...this.items];
  }

  private updateBackpressure(): void {
    if (!this.isPaused && this.items.length >= this.highWaterMark) {
      this.isPaused = true;
      this.onBackpressureChange?.(true);
    } else if (this.isPaused && this.items.length <= this.lowWaterMark) {
      this.isPaused = false;
      this.onBackpressureChange?.(false);
    }
  }
}

/**
 * Coordinates active turns, request IDs, sequence numbers, and cancellation tokens
 * so stale worker results are deterministically isolated and discarded.
 */
export class TurnResourceScheduler {
  private currentTurnId: string | null = null;
  private canceledTurnIds = new Set<string>();
  private turnAbortControllers = new Map<string, AbortController>();
  private sequenceCounters = new Map<string, number>();
  private requestCounter = 0;

  startTurn(customTurnId?: string): { turnId: string; signal: AbortSignal } {
    if (this.currentTurnId) {
      this.cancelTurn(this.currentTurnId, 'Superseded by new turn');
    }

    const turnId = customTurnId ?? `turn_${Date.now()}_${++this.requestCounter}`;
    const controller = new AbortController();
    this.currentTurnId = turnId;
    this.turnAbortControllers.set(turnId, controller);
    this.sequenceCounters.set(turnId, 0);

    return { turnId, signal: controller.signal };
  }

  getActiveTurnId(): string | null {
    return this.currentTurnId;
  }

  nextSequence(turnId: string): number {
    const current = this.sequenceCounters.get(turnId) ?? 0;
    const next = current + 1;
    this.sequenceCounters.set(turnId, next);
    return next;
  }

  nextRequestId(prefix = 'req'): string {
    return `${prefix}_${Date.now()}_${++this.requestCounter}`;
  }

  isTurnValid(turnId: string): boolean {
    if (!turnId) return false;
    if (this.canceledTurnIds.has(turnId)) return false;
    return this.currentTurnId === turnId;
  }

  cancelTurn(turnId: string, reason = 'Turn interrupted'): void {
    this.canceledTurnIds.add(turnId);
    const controller = this.turnAbortControllers.get(turnId);
    if (controller && !controller.signal.aborted) {
      controller.abort(new Error(reason));
    }
    this.turnAbortControllers.delete(turnId);
    if (this.currentTurnId === turnId) {
      this.currentTurnId = null;
    }
  }

  completeTurn(turnId: string): void {
    this.turnAbortControllers.delete(turnId);
    if (this.currentTurnId === turnId) {
      this.currentTurnId = null;
    }
  }
}
