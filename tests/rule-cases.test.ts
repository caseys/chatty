import { describe, expect, it } from 'vitest';
import { promptRules, rulesNamedBy } from '../src/core/orchestrator.ts';

describe('prompt rules for a program being changed', () => {
  it("keeps a rule the program being changed uses, whatever the request's words", () => {
    expect(promptRules('make it red', true, 'const c = document.createElement("canvas")')).toContain('Use <canvas>');
    expect(promptRules('make it red', true)).not.toContain('Use <canvas>');
  });
});

describe('song titles, games and 3D', () => {
  it('reads no drawing into a song named for one, or a sound shaped like one', () => {
    for (const r of ['Play Twinkle Twinkle Little Star on the piano', 'Play Twinkle Twinkle Little Star', 'Play Somewhere Over the Rainbow on the guitar', 'Play a square wave tone', 'Play a drum pattern']) {
      expect(rulesNamedBy(r).has('canvas'), r).toBe(false);
      expect(rulesNamedBy(r).has('card'), r).toBe(false);
    }
    for (const r of ['Draw a star', 'Draw stars in the night sky while soft piano music plays', 'Show a star that twinkles to a piano tune', 'A bouncing ball that beeps when it hits a wall', 'Make a circle that plays a chime when I tap it'])
      expect(rulesNamedBy(r).has('card') && rulesNamedBy(r).has('canvas'), r).toBe(true);
  });

  it('hears no sound in a game played, unless one is named', () => {
    const sounds = (r: string) => [...rulesNamedBy(r)].filter((rule) => rule === 'music' || rule === 'fx');
    for (const r of ['Make a pong game I play with the arrow keys', 'Let me play pong against the computer', "Let's play a game of fetch with a dog", "Let's play tic-tac-toe"]) expect(sounds(r), r).toEqual([]);
    expect(sounds('Play a song on the piano')).toEqual(['music']);
    expect(sounds('play a beep')).toEqual(['fx']);
    expect(sounds('Play a snake game that beeps when the snake eats')).toEqual(['fx']);
    expect(sounds('Play something')).toEqual(['music', 'fx']);
  });

  it('gives 3D to a 3D scene or a game that asks for 3D, not to every game', () => {
    for (const r of ['Make a snake game', 'Make a pong game I play with the arrow keys', 'Make a tic-tac-toe game where two players take turns tapping the squares', 'Make a racing game'])
      expect(rulesNamedBy(r).has('three'), r).toBe(false);
    for (const r of ['Make a 3D racing game', 'a 3D game', 'Make a spinning cube', 'Show a spinning 3D cube']) expect(rulesNamedBy(r).has('three'), r).toBe(true);
    expect(rulesNamedBy('Make a snake game').has('canvas')).toBe(true);
  });
});

describe('which rules a drawing, the weather and a letter get', () => {
  it('puts the canvas rule forward for what is drawn, not a game in words, square numbers or wordplay', () => {
    for (const r of ['a guessing game where I guess a number between 1 and 100', 'show a table of the first ten square numbers', 'draw me a conclusion from this: it rained and the grass is wet', 'paint me a picture with words of a sunset', 'memory matching game'])
      expect(rulesNamedBy(r).has('canvas'), r).toBe(false);
    for (const r of ['Let me play pong against the computer', 'an analog clock with hands', 'Make a snake game', 'Draw a memory card'])
      expect(rulesNamedBy(r).has('canvas'), r).toBe(true);
    expect(rulesNamedBy('Play an analog synth bass line').has('canvas')).toBe(false);
    expect(rulesNamedBy('memory matching game').has('three')).toBe(false);
    expect(rulesNamedBy('a heart that beats with CSS').has('music')).toBe(false);
    expect(rulesNamedBy('Play a beat that sounds like a heart beating').has('music')).toBe(true);
  });

  it('keeps the weather rule off writing about the weather, and the text rule off a letter to write', () => {
    expect(rulesNamedBy('write one sentence describing the weather in the opening of my novel').has('weather')).toBe(false);
    expect(rulesNamedBy('Write a program that tells me the temperature in Oslo').has('weather')).toBe(true);
    expect(rulesNamedBy('copy editing tips for a cover letter').has('text')).toBe(false);
    expect(rulesNamedBy("Count the letters in 'mississippi'").has('text')).toBe(true);
  });
});

describe('the text rule', () => {
  it('is put forward for text to count, reverse or change, and only then', () => {
    expect(rulesNamedBy('Count the words in this sentence: the cat sat').has('text')).toBe(true);
    expect(rulesNamedBy('Reverse the word "pineapple"').has('text')).toBe(true);
    expect(rulesNamedBy("Change every 'a' to 'o' in 'banana'").has('text')).toBe(true);
    expect(rulesNamedBy('Who was Ada Lovelace?').has('text')).toBe(false);
    expect(promptRules('Make it all uppercase', true)).toContain('For text tools');
    expect(promptRules('Tell me a joke about cats', true)).not.toContain('For text tools');
  });
});

describe('keyboard and CSS motion rules', () => {
  const named = (request: string) => [...rulesNamedBy(request)].filter((rule) => ['keys', 'css'].includes(rule));

  it('are put forward by their keywords', () => {
    expect(named('Move a square with the arrow keys')).toEqual(['keys']);
    expect(named('Show the name of whichever key I press')).toEqual(['keys']);
    expect(named('Fade a word in and out')).toEqual(['css']);
  });

  it('are not put forward by their look-alikes', () => {
    expect(named('Make a piano keyboard I can play by tapping the keys')).toEqual([]);
    expect(named('Play a short tune in the key of G major')).toEqual([]);
    expect(named('Give me three keys to staying productive')).toEqual([]);
    expect(named('Animate 10 colored balls bouncing around the screen')).toEqual([]);
  });

  it('put the card rule forward for what is played with keys or dragged', () => {
    expect(rulesNamedBy('Let me steer a little car around with WASD').has('card')).toBe(true);
    expect(rulesNamedBy('Make a box I can drag around').has('card')).toBe(true);
  });
});

describe('saving and the weather', () => {
  it('put forward by what the request asks for, not by look-alike words', () => {
    const named = (request: string) => [...rulesNamedBy(request)].filter((r) => r === 'save' || r === 'weather');
    expect(named('Save my notes so they are there next time')).toEqual(['save']);
    expect(named("What's the weather like here?")).toEqual(['weather']);
    for (const request of ['Play the notes C, E and G', 'Keep the ball bouncing', 'Now make the ball red', 'Count to 10 one at a time', 'Make a rainbow button', 'Draw rain on a street', 'Sing happy birthday', 'Make a snake game that remembers my high score'])
      expect(named(request)).toEqual([]);
    // The weather has its own rule, but its history and causes are facts
    expect(rulesNamedBy("What's the weather in Paris?").has('facts')).toBe(false);
    expect(rulesNamedBy('Who invented the weather forecast?').has('facts')).toBe(true);
  });

  it('take a program being changed by what it uses, not by its words (window, ctx.save())', () => {
    const program = 'window.addEventListener("click", () => { ctx.save(); const notes = [60, 62]; performance.now(); });';
    const rules = promptRules(`make it blue\n${program}`, true, program);
    expect(rules).not.toContain('For weather');
    expect(rules).not.toContain('To keep what the user types between visits');
    const saving = 'let value = JSON.parse(localStorage.getItem("notes"));';
    expect(promptRules(`make it blue\n${saving}`, true, saving)).toContain('To keep what the user types between visits');
  });

  it('show each value to fill in as an empty slot with what goes there', () => {
    const rules = promptRules('', false);
    expect(rules).toContain('const place = ""; // the city asked about');
    expect(rules).toContain('const key = ""; // what is kept');
    expect(rules).not.toContain('<lat>');
  });
});

describe('data from a web address and the clipboard', () => {
  it('put forward by what the request asks for, not by look-alike words', () => {
    const named = (request: string) => [...rulesNamedBy(request)].filter((r) => r === 'fetch' || r === 'clipboard');
    expect(named('Tell me a cat fact from https://catfact.ninja/fact')).toEqual(['fetch']);
    expect(named('Show the current price of bitcoin from the CoinGecko API')).toEqual(['fetch']);
    expect(named('Generate a random password and add a button to copy it')).toEqual(['clipboard']);
    expect(named('Make a share link box with a copy to clipboard button')).toEqual(['clipboard']);
    for (const request of [
      'What is an API?',
      "Let's play a game of fetch with a dog",
      'Display this image: https://picsum.photos/id/237/400/300.jpg',
      'Tell me a random joke',
      'Draw a copy of the Mona Lisa',
      'Copy the style of Picasso in a drawing',
      'Make toothpaste ads',
      'Write a poem about a copycat',
    ])
      expect(named(request), request).toEqual([]);
  });

  it('take a program being changed by what it uses', () => {
    const program = 'navigator.clipboard.writeText(text); const data = await (await fetch(url)).json();';
    const rules = promptRules(`make it blue\n${program}`, true, program);
    expect(rules).toContain('For data from a web address');
    expect(rules).toContain('To copy text for the user');
  });

  it('show each value to fill in as an empty slot, the clipboard write inside a click', () => {
    const rules = promptRules('', false);
    expect(rules).toContain('const url = ""; // the address asked for');
    expect(rules).toContain('button.onclick = () => navigator.clipboard.writeText(""); // the text to copy');
  });
});

describe('the canvas rule and motion', () => {
  it('adds the motion sentence only when a drawing request asks for motion', () => {
    const motion = 'For motion, keep each thing';
    expect(promptRules('Animate 10 colored balls bouncing around the screen', true)).toContain(motion);
    expect(promptRules('Make a game where two players take turns tapping squares', true)).not.toContain(motion);
    expect(promptRules('Draw a red barn with a blue sky behind it.', true)).not.toContain(motion);
    expect(promptRules('Draw a red barn with a blue sky behind it.', true)).toContain('Use <canvas> for visuals');
  });
});
