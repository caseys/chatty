import { describe, expect, it } from 'vitest';
import { renameMembers, unknownMemberError, unknownMembers } from '../src/core/property-check.ts';

class FakeContext2D {
  fillStyle = '';
  strokeStyle = '';
  lineWidth = 1;
  fillRect() {}
  arc() {}
  fill() {}
}
const scope = { CanvasRenderingContext2D: FakeContext2D, document } as unknown as Record<string, unknown>;
// Instance fields aren't on the prototype: put them there, as the browser does
for (const key of ['fillStyle', 'strokeStyle', 'lineWidth']) Object.defineProperty(FakeContext2D.prototype, key, { value: '', writable: true });

const canvasCode = (body: string) => `const c = document.createElement('canvas');\nconst ctx = c.getContext('2d');\n${body}`;

describe('members an object does not have', () => {
  it('finds a slipped property and the real name it means', () => {
    const [issue] = unknownMembers(canvasCode("ctx.fillstyle = 'red';\nctx.fillRect(0, 0, 9, 9);"), scope);
    expect(issue).toMatchObject({ line: 3, object: 'ctx', member: 'fillstyle', slip: 'fillStyle' });
    expect(renameMembers("ctx.fillstyle = 'red';", [{ object: 'ctx', from: 'fillstyle', to: 'fillStyle' }])).toBe("ctx.fillStyle = 'red';");
  });

  it('reports a made-up property with the closest real names', () => {
    const [issue] = unknownMembers(canvasCode("ctx.fillColor = 'red';"), scope);
    expect(issue.slip).toBeNull();
    expect(unknownMemberError(issue)).toMatch(/^ctx\.fillColor is not a property of a CanvasRenderingContext2D\. Its closest: .*fillStyle/);
  });

  it("checks style objects, and leaves elements' own properties alone", () => {
    const code = "const b = document.getElementById('b');\nb.count = 0;\nb.style.backgroundColour = 'blue';";
    const issues = unknownMembers(code, scope);
    expect(issues.map((i) => `${i.object}.${i.member}`)).toEqual(['b.style.backgroundColour']);
    expect(issues[0].slip).toBe('backgroundColor');
  });

  it('leaves a property the program sets and reads itself', () => {
    expect(unknownMembers(canvasCode('ctx.myAngle = 1;\nctx.arc(0, 0, 5, 0, ctx.myAngle);'), scope)).toEqual([]);
  });
});
