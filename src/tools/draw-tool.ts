// ============================================================================
// Drawing & Canvas Graphics Tool for Chatty
// Renders 2D/3D graphics, animations, diagrams, and visual scenes on screen
// via HTML5 Canvas or SVG in the sandboxed iframe overlay.
// ============================================================================

import type { ToolDefinition } from '../types/index.ts';
import type { JavascriptExecutionCallback, JavascriptRuntime } from './javascript-runtime.ts';

export function createDrawGraphicsTool(
  runtime: JavascriptRuntime,
  callback?: JavascriptExecutionCallback
): ToolDefinition {
  return {
    name: 'draw_graphics',
    description:
      'Draws graphics, charts, diagrams, canvas animations, and visual scenes on the screen. Call this whenever the user asks to draw, illustrate, animate, or show something visually.',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'What to draw, animate, or visualize on screen (e.g. "a colorful sunset", "spinning 3d cube", "pie chart")',
        },
      },
      required: ['prompt'],
    },
    execute: async (args: Record<string, unknown>) => {
      const anyStr = Object.values(args).find(
        (v) => typeof v === 'string' && v.trim().length > 0
      ) as string | undefined;
      const prompt = String(
        args.prompt ||
          args.task ||
          args.query ||
          args.drawing ||
          args.description ||
          anyStr ||
          ''
      ).trim();
      const drawTask = prompt || 'draw an artistic colorful pattern on canvas';
      return runtime.executeTask(
        {
          task: `Render the following visual onto the screen (using HTML5 canvas, SVG, or styled DOM div elements appended to root): ${drawTask}`,
          mode: 'iframe',
        },
        callback
      );
    },
  };
}
