import { describe, expect, it } from 'vitest';
import { fetchWeather, skyOf } from '../src/tools/web-tools.ts';

/** A fetch that answers by URL, and records what was asked */
function fakeFetch(answers: Array<[RegExp, unknown, number?]>) {
  const asked: string[] = [];
  const fn = (url: string) => {
    asked.push(url);
    const hit = answers.find(([pattern]) => pattern.test(url));
    if (!hit) return Promise.reject(new Error('offline'));
    const [, body, status = 200] = hit;
    return Promise.resolve({ ok: status < 400, status, json: () => Promise.resolve(body) });
  };
  return { fn, asked };
}

const FORECAST: [RegExp, unknown] = [/api\.open-meteo\.com\/v1\/forecast/, { current: { temperature_2m: 14.6, precipitation: 0.2, weather_code: 61 } }];

describe('getWeather', () => {
  it('finds the place, then its weather right now', async () => {
    const { fn, asked } = fakeFetch([[/geocoding.*name=Paris/, { results: [{ name: 'Paris', latitude: 48.85, longitude: 2.35 }] }], FORECAST]);
    expect(await fetchWeather('Paris', fn)).toEqual({ place: 'Paris', temperature: 14.6, rain: 0.2, sky: 'rain' });
    expect(asked[1]).toContain('latitude=48.85&longitude=2.35');
  });

  it('tries the city alone when "City, Country" finds nothing', async () => {
    const { fn, asked } = fakeFetch([
      [/name=Austin%2C%20TX/, { results: [] }],
      [/name=Austin&/, { results: [{ name: 'Austin', latitude: 30.27, longitude: -97.74 }] }],
      FORECAST,
    ]);
    expect((await fetchWeather('Austin, TX', fn)).place).toBe('Austin');
    expect(asked).toHaveLength(3);
  });

  it('uses where the visitor is for no place, an empty one or "here"', async () => {
    // ("Where the user is": the rule's comment, copied into the slot)
    for (const place of [undefined, '', 'here', 'my location', 'Current location', 'Where the user is']) {
      const { fn, asked } = fakeFetch([[/get\.geojs\.io/, { city: 'West Linn', latitude: '45.36', longitude: '-122.61' }], FORECAST]);
      expect((await fetchWeather(place, fn)).place).toBe('West Linn');
      expect(asked[0]).toContain('geojs');
    }
  });

  it('says what went wrong: no such place, a service down, no network', async () => {
    await expect(fetchWeather('Xyzzyqq', fakeFetch([[/geocoding/, {}]]).fn)).rejects.toThrow('no place called "Xyzzyqq" was found');
    const down = fakeFetch([[/geocoding/, { results: [{ name: 'Paris', latitude: 1, longitude: 2 }] }], [/forecast/, {}, 503]]);
    await expect(fetchWeather('Paris', down.fn)).rejects.toThrow('the weather service answered 503');
    await expect(fetchWeather('Paris', fakeFetch([]).fn)).rejects.toThrow('could not reach the place search');
  });

  it('puts the weather code in words', () => {
    expect([0, 3, 45, 53, 63, 81, 73, 95, 7].map(skyOf)).toEqual(['clear', 'cloudy', 'fog', 'drizzle', 'rain', 'rain', 'snow', 'thunderstorm', 'unknown']);
  });
});
