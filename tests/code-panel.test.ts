// The code panel while a reply streams: text and Share's code update at once, painting once a frame
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFrameCoalescer } from '../src/frame-coalescer.ts';

vi.mock('../src/core/voice-assistant-engine.ts', () => ({
  VoiceAssistantEngine: class {
    constructor() {
      return new Proxy(this, { get: (_t, key) => (key === 'then' ? undefined : vi.fn()) });
    }
  },
}));

// main.ts starts the app when the page has loaded: pretend it hasn't, so only the class is loaded
Object.defineProperty(document, 'readyState', { value: 'loading', configurable: true });
window.matchMedia ??= ((query: string) => ({ matches: false, media: query, addEventListener() {}, removeEventListener() {} })) as typeof window.matchMedia;
const { MinimalVoiceApp } = await import('../src/main.ts');
delete (document as { readyState?: string }).readyState;

type PanelApp = {
  rawOutputEl: HTMLElement;
  rawOutputFrame: ReturnType<typeof createFrameCoalescer<string>>;
  showingRunLog: boolean;
  lastRawOutput: string;
  panelCode: string;
  engine: { getRunLog(): string };
  setRawOutput(text: string, streaming?: boolean): void;
  paintRawOutput(code: string): void;
  copyRawPanel(link: HTMLElement): Promise<void>;
};

describe('code panel streaming', () => {
  let frames: Array<() => void>;
  let app: PanelApp;

  beforeEach(() => {
    frames = [];
    // The class's own methods on a bare object: building the whole app needs the engine and the page
    app = Object.create(MinimalVoiceApp.prototype) as PanelApp;
    app.rawOutputEl = document.createElement('code');
    app.engine = { getRunLog: () => 'ran the program' };
    app.showingRunLog = false;
    app.lastRawOutput = '';
    app.panelCode = '';
    app.rawOutputFrame = createFrameCoalescer<string>(
      (code) => app.paintRawOutput(code),
      (callback) => frames.push(callback),
      () => {
        frames.length = 0;
      }
    );
  });

  const runFrame = () => {
    const due = frames.splice(0);
    for (const callback of due) callback();
  };

  it('paints once per frame with the last text, while the readers see it at once', () => {
    const paint = vi.spyOn(app, 'paintRawOutput');
    app.setRawOutput('const a', true);
    app.setRawOutput('const a = 1;\nspeak("hi");', true);
    app.setRawOutput('const a = 1;\nspeak("hi");\nconst b = 2;', true);
    expect(paint).not.toHaveBeenCalled();
    expect(app.rawOutputEl.textContent).toBe('');
    // Copy, Share and the log toggle read these without waiting for the frame
    expect(app.lastRawOutput).toBe('const a = 1;\nspeak("hi");\nconst b = 2;');
    expect(app.panelCode).toBe('const a = 1;\nspeak("hi");\nconst b = 2;');
    runFrame();
    expect(paint).toHaveBeenCalledTimes(1);
    // speak() lines stay out of the panel
    expect(app.rawOutputEl.textContent).toBe('const a = 1;\nconst b = 2;');
  });

  it('strips code fences from both the panel and the shared code', () => {
    app.setRawOutput('```js\nlet x = 1;\n```', true);
    expect(app.panelCode).toBe('let x = 1;');
    runFrame();
    expect(app.rawOutputEl.textContent).toBe('let x = 1;');
  });

  it('paints at once when the text does not come from the stream', () => {
    app.setRawOutput('streamed', true);
    app.setRawOutput('loaded from history');
    expect(app.rawOutputEl.textContent).toBe('loaded from history');
    // The streamed frame that was waiting draws nothing over it
    runFrame();
    expect(app.rawOutputEl.textContent).toBe('loaded from history');
  });

  it('switches to the run log at once, over any text waiting for its frame', () => {
    app.setRawOutput('let y = 2;', true);
    app.showingRunLog = true;
    app.setRawOutput(app.lastRawOutput);
    expect(app.rawOutputEl.textContent).toContain('ran the program');
    runFrame();
    expect(app.rawOutputEl.textContent).toContain('ran the program');
    // And back to the code
    app.showingRunLog = false;
    app.setRawOutput(app.lastRawOutput);
    expect(app.rawOutputEl.textContent).toBe('let y = 2;');
  });

  it('copy paints the pending text first', async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: write }, configurable: true });
    app.setRawOutput('let z = 3;', true);
    await app.copyRawPanel(document.createElement('span'));
    expect(write).toHaveBeenCalledWith('let z = 3;');
  });
});
