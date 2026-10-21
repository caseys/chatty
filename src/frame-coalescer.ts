/**
 * Hands `render` the newest value at most once per animation frame. A streaming reply updates
 * the code panel for every token; highlighting the whole program each time is quadratic work,
 * so only the latest text is drawn, one frame later. flush() draws a pending value now.
 */
export interface FrameCoalescer<T> {
  push(value: T): void;
  flush(): void;
  /** Drops a pending value without drawing it */
  cancel(): void;
}

export function createFrameCoalescer<T>(
  render: (value: T) => void,
  requestFrame: (callback: () => void) => number = (callback) => requestAnimationFrame(callback),
  cancelFrame: (id: number) => void = (id) => cancelAnimationFrame(id)
): FrameCoalescer<T> {
  let pending: { value: T } | null = null;
  let frame: number | null = null;
  const draw = (): void => {
    frame = null;
    const next = pending;
    pending = null;
    if (next) render(next.value);
  };
  return {
    push(value) {
      pending = { value };
      // A frame already waiting will draw the newest value
      if (frame === null) frame = requestFrame(draw);
    },
    flush() {
      if (frame !== null) cancelFrame(frame);
      draw();
    },
    cancel() {
      if (frame !== null) cancelFrame(frame);
      frame = null;
      pending = null;
    },
  };
}
