import { describe, expect, it } from 'vitest';
import { loopProtect } from '../src/tools/loop-protect.ts';
import { JavascriptRuntime } from '../src/tools/javascript-runtime.ts';

const LIM = 100;
// Run protected code synchronously as an async function body.
const run = async (code: string): Promise<unknown> => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction(loopProtect(code, LIM))();
};

describe('loopProtect', () => {
  it.each([
    ['while(true){}', 'while(true){}'],
    ['for(;;);', 'for(;;);'],
    ['do{}while(1)', 'do{}while(1)'],
    ['for-in-ish', 'const o={a:1}; for (const k in o) { while(true); }'],
    ['nested', 'for(let i=0;i<3;i++){ for(;;){} }'],
    ['arrow', 'const f=()=>{ while(1){} }; f();'],
    ['class method', 'class A{ m(){ for(;;){} } } new A().m();'],
    ['if-body no braces', 'if (true) while(true);'],
  ])('breaks infinite loop: %s', async (_n, code) => {
    await expect(run(code)).rejects.toThrow(/Loop exceeded/);
  });

  it('handles labeled loops with continue/break', async () => {
    const code = `
      let n = 0;
      outer: for (let i = 0; i < 5; i++) {
        inner: for (let j = 0; j < 5; j++) {
          if (j === 2) continue outer;
          if (i === 3) break outer;
          n++;
        }
      }
      return n;`;
    expect(await run(code)).toBe(6);
    await expect(run('a: b: while(true){ continue a; }')).rejects.toThrow(/Loop exceeded/);
    await expect(run('x: while(true) continue x;')).rejects.toThrow(/Loop exceeded/);
  });

  it('leaves non-loop text containing while( untouched', () => {
    const code = 'const s = "while(true){}"; const r = /while\\(/; const t = `for(;;) ${s}`; return t;';
    expect(loopProtect(code)).toBe(code);
  });

  it('does not instrument loop-looking template/regex but still guards real loops', async () => {
    const code = 'const s = `while(true){} ${1+1}`; let c=0; for (const x of [1,2,3]) c+=x; return s + c;';
    expect(await run(code)).toBe('while(true){} 26');
  });

  it('runs async/await code', async () => {
    const code = `
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));
      let total = 0;
      for (let i = 0; i < 3; i++) { await sleep(1); total += i; }
      return total;`;
    expect(await run(code)).toBe(3);
  });

  it('returns code unchanged on syntax error', () => {
    const bad = 'while(true {';
    expect(loopProtect(bad)).toBe(bad);
  });
});

describe('JavascriptRuntime integration', () => {
  it('surfaces loop guard as a normal error result', async () => {
    const rt = new JavascriptRuntime({ mode: 'eval' });
    const res = await rt.execute('while(true){}');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/Loop exceeded/);
  }, 10000);
});
