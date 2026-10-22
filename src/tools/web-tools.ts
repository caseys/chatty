// ============================================================================
// Web Search & Knowledge Tools
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

/** The weather right now somewhere, as getWeather() gives it to a program */
export interface CurrentWeather {
  /** The place found, like "Paris" */
  place: string;
  /** °C */
  temperature: number;
  /** mm of rain (and snow, as water) in the last hour */
  rain: number;
  /** The sky in a word or two, like "clear", "cloudy" or "rain" (left out, a program made it up) */
  sky: string;
}

/** WMO weather codes (Open-Meteo's weather_code) in words */
export function skyOf(code: number): string {
  if (code === 0) return 'clear';
  if (code === 1) return 'mostly clear';
  if (code === 2) return 'partly cloudy';
  if (code === 3) return 'cloudy';
  if (code === 45 || code === 48) return 'fog';
  if (code >= 51 && code <= 57) return 'drizzle';
  if ((code >= 61 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95 && code <= 99) return 'thunderstorm';
  return 'unknown';
}

/** What a program passes for "where the user is" (models write these as well as leaving the place out) */
const HERE =
  /^(?:|here|my (?:location|place|city|area)|(?:current|this|your|the user'?s) location|where (?:i am|the user is|you are)|near me|nearby|local|user|the user)$/i;

type FetchLike = (url: string) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/**
 * The weather right now for a place by name, or with no place where the visitor is (by IP). Small
 * models can't know a city's latitude and longitude, and two chained fetches were too much for them,
 * so the card's getWeather(place) does it: Open-Meteo's geocoding, then its forecast (both keyless and
 * open to cross-origin requests), and geojs.io for the visitor's location. Throws an Error that says
 * what went wrong, for the program (and the fix turn) to see.
 */
export async function fetchWeather(place?: unknown, fetchFn: FetchLike = (url) => fetch(url, { credentials: 'omit' })): Promise<CurrentWeather> {
  const getJson = async (url: string, what: string): Promise<any> => {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await fetchFn(url);
    } catch (err) {
      throw new Error(`getWeather: could not reach the ${what} (${err instanceof Error ? err.message : String(err)})`);
    }
    if (!res.ok) throw new Error(`getWeather: the ${what} answered ${res.status}`);
    return res.json();
  };
  const asked = typeof place === 'string' && !HERE.test(place.trim()) ? place.trim() : '';
  let found: { name: string; latitude: number; longitude: number };
  if (asked) {
    const search = async (name: string) =>
      (await getJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1`, 'place search'))?.results?.[0];
    // "Paris, France" or "Austin, TX": the city alone when the whole name finds nothing
    const hit = (await search(asked)) ?? (asked.includes(',') ? await search(asked.split(',')[0].trim()) : undefined);
    if (!hit) throw new Error(`getWeather: no place called "${asked}" was found`);
    found = { name: String(hit.name ?? asked), latitude: Number(hit.latitude), longitude: Number(hit.longitude) };
  } else {
    const here = await getJson('https://get.geojs.io/v1/ip/geo.json', 'location service');
    found = { name: String(here?.city || here?.region || here?.country || 'here'), latitude: Number(here?.latitude), longitude: Number(here?.longitude) };
  }
  if (!Number.isFinite(found.latitude) || !Number.isFinite(found.longitude)) throw new Error(`getWeather: no location for "${asked || 'here'}"`);
  const forecast = await getJson(
    `https://api.open-meteo.com/v1/forecast?latitude=${found.latitude}&longitude=${found.longitude}&current=temperature_2m,precipitation,weather_code`,
    'weather service'
  );
  const temperature = Number(forecast?.current?.temperature_2m);
  if (!Number.isFinite(temperature)) throw new Error('getWeather: the weather service gave no temperature');
  return { place: found.name, temperature, rain: Number(forecast?.current?.precipitation) || 0, sky: skyOf(Number(forecast?.current?.weather_code)) };
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
