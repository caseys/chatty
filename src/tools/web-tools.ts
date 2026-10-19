// ============================================================================
// Web Search & Knowledge Tools for Gemma
// - Wikipedia Search & Summary Tool
// - Instant Answers Tool (DuckDuckGo open CORS endpoint)
// Keeps descriptions and parameter options minimal, clean, and easy to understand.
// ============================================================================

import type { ToolDefinition } from '../types/index.ts';

/**
 * Fetches Wikipedia summary for a topic.
 */
export async function fetchWikipediaSummary(query: string): Promise<{
  title?: string;
  summary?: string;
  description?: string;
  error?: string;
}> {
  const cleanQuery = typeof query === 'string' ? query.trim() : String(query ?? '').trim();
  if (!cleanQuery) {
    return { error: 'No query provided' };
  }

  try {
    // 1. Search Wikipedia for matching article title
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(
      cleanQuery
    )}&utf8=&format=json&origin=*`;
    const searchRes = await fetch(searchUrl, { headers: { Accept: 'application/json' } });
    if (!searchRes.ok) {
      return { error: `Wikipedia search HTTP ${searchRes.status}` };
    }

    const searchData = (await searchRes.json()) as {
      query?: { search?: Array<{ title: string; snippet: string }> };
    };
    const hits = searchData?.query?.search;
    if (!Array.isArray(hits) || hits.length === 0) {
      return { error: `No Wikipedia article found for "${cleanQuery}"` };
    }

    const topTitle = hits[0].title;

    // 2. Fetch page summary for the top article
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(
      topTitle
    )}`;
    const summaryRes = await fetch(summaryUrl, { credentials: 'omit' });
    if (summaryRes.ok) {
      const summaryData = (await summaryRes.json()) as {
        title?: string;
        extract?: string;
        description?: string;
      };
      if (summaryData?.extract) {
        return {
          title: summaryData.title ?? topTitle,
          summary: summaryData.extract,
          description: summaryData.description,
        };
      }
    }

    // Fallback: clean the HTML snippet from search results
    const cleanSnippet = hits[0].snippet.replace(/<[^>]+>/g, '').trim();
    return {
      title: topTitle,
      summary: cleanSnippet,
    };
  } catch (err) {
    return {
      error: `Failed to fetch Wikipedia: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Creates the Wikipedia Search & Summary Tool definition.
 */
export function createWikipediaTool(): ToolDefinition {
  return {
    name: 'wikipedia',
    description: 'Searches Wikipedia and returns a summary for a topic.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Topic to search',
        },
      },
      required: ['query'],
    },
    execute: async (args: Record<string, unknown>) => {
      const query = String(args.query ?? '').trim();
      return fetchWikipediaSummary(query);
    },
  };
}

/**
 * Creates the Instant Answers Tool definition.
 */
export function createInstantAnswersTool(): ToolDefinition {
  return {
    name: 'instant_answers',
    description: 'Returns quick answers, facts, or definitions.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Query or question',
        },
      },
      required: ['query'],
    },
    execute: async (args: Record<string, unknown>) => {
      const query = String(args.query ?? '').trim();
      if (!query) {
        return { error: 'No query provided' };
      }

      try {
        const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(
          query
        )}&format=json&no_html=1&skip_disambig=1`;
        const res = await fetch(url);
        if (!res.ok) {
          return { error: `Instant answer HTTP ${res.status}` };
        }

        const data = (await res.json()) as {
          Answer?: string;
          Heading?: string;
          AbstractText?: string;
          AbstractSource?: string;
          Definition?: string;
          DefinitionSource?: string;
          RelatedTopics?: Array<{ Text?: string; Topics?: Array<{ Text?: string }> }>;
        };

        // 1. Direct answer/computation/constant
        if (data.Answer) {
          return {
            heading: data.Heading || query,
            answer: String(data.Answer),
          };
        }

        // 2. Abstract text
        if (data.AbstractText) {
          return {
            heading: data.Heading || query,
            answer: String(data.AbstractText),
            source: data.AbstractSource || 'DuckDuckGo',
          };
        }

        // 3. Dictionary definition
        if (data.Definition) {
          return {
            heading: data.Heading || query,
            answer: String(data.Definition),
            source: data.DefinitionSource,
          };
        }

        // 4. First related topic
        if (Array.isArray(data.RelatedTopics) && data.RelatedTopics.length > 0) {
          const first = data.RelatedTopics[0];
          const text = first?.Text || (first?.Topics && first.Topics[0]?.Text);
          if (text) {
            return {
              heading: data.Heading || query,
              answer: String(text),
            };
          }
        }

        return { error: `No instant answer found for "${query}"` };
      } catch (err) {
        return {
          error: `Failed to fetch instant answer: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
