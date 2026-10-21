import { describe, expect, it, vi } from 'vitest';
import { createFrameCoalescer } from '../src/frame-coalescer.ts';

/** A frame clock the test advances by hand */
function manualFrames() {
  let next = 1;
  const queued = new Map<number, () => void>();
  return {
    request: (callback: () => void) => {
      queued.set(next, callback);
      return next++;
    },
    cancel: (id: number) => void queued.delete(id),
    tick() {
      const callbacks = [...queued.values()];
      queued.clear();
      for (const callback of callbacks) callback();
    },
    get waiting() {
      return queued.size;
    },
  };
}

describe('frame coalescer', () => {
  it('draws only the newest value, once per frame', () => {
    const frames = manualFrames();
    const render = vi.fn();
    const coalescer = createFrameCoalescer<string>(render, frames.request, frames.cancel);
    coalescer.push('a');
    coalescer.push('ab');
    coalescer.push('abc');
    expect(render).not.toHaveBeenCalled();
    expect(frames.waiting).toBe(1);
    frames.tick();
    expect(render).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledWith('abc');
  });

  it('draws again for a value that arrives after the frame', () => {
    const frames = manualFrames();
    const render = vi.fn();
    const coalescer = createFrameCoalescer<string>(render, frames.request, frames.cancel);
    coalescer.push('one');
    frames.tick();
    coalescer.push('two');
    frames.tick();
    expect(render.mock.calls).toEqual([['one'], ['two']]);
    // Nothing pending: a frame with no new value draws nothing
    frames.tick();
    expect(render).toHaveBeenCalledTimes(2);
  });

  it('flush draws the pending value now and the cancelled frame draws nothing more', () => {
    const frames = manualFrames();
    const render = vi.fn();
    const coalescer = createFrameCoalescer<string>(render, frames.request, frames.cancel);
    coalescer.push('x');
    coalescer.push('xy');
    coalescer.flush();
    expect(render.mock.calls).toEqual([['xy']]);
    expect(frames.waiting).toBe(0);
    frames.tick();
    expect(render).toHaveBeenCalledTimes(1);
    // Flushing with nothing pending draws nothing
    coalescer.flush();
    expect(render).toHaveBeenCalledTimes(1);
  });

  it('cancel drops the pending value', () => {
    const frames = manualFrames();
    const render = vi.fn();
    const coalescer = createFrameCoalescer<string>(render, frames.request, frames.cancel);
    coalescer.push('x');
    coalescer.cancel();
    frames.tick();
    coalescer.flush();
    expect(render).not.toHaveBeenCalled();
    // And it still works afterwards
    coalescer.push('y');
    frames.tick();
    expect(render).toHaveBeenCalledWith('y');
  });

  it('a value pushed while drawing waits for the next frame', () => {
    const frames = manualFrames();
    const seen: string[] = [];
    const coalescer = createFrameCoalescer<string>(
      (value) => {
        seen.push(value);
        if (value === 'first') coalescer.push('second');
      },
      frames.request,
      frames.cancel
    );
    coalescer.push('first');
    frames.tick();
    expect(seen).toEqual(['first']);
    frames.tick();
    expect(seen).toEqual(['first', 'second']);
  });
});
