/**
 * Weather for the wall: cached, degrading to the last good reading, and never
 * able to take the screen down.
 */
import { makeKV } from './helpers/kv.mjs';
import { loadWorker, harness } from './helpers/load.mjs';

const W = await loadWorker();
const { ok, eq, done } = harness();

let calls, reply;
const body = {
  current: { temperature_2m: 18.4, weather_code: 3 },
  daily: {
    time: ['2026-11-09', '2026-11-10'],
    temperature_2m_max: [18.9, 23.4], temperature_2m_min: [15.6, 17.1],
    weather_code: [61, 0],
  },
};
globalThis.fetch = async url => {
  calls.push(String(url));
  if (reply === 'down') return new Response('nope', { status: 500 });
  if (reply === 'throw') throw new Error('network');
  return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
};
const env = extra => ({ CHATS: makeKV(), TZ_NAME: 'Europe/Madrid', ...extra });

// ------------------------------------------------------------- the reading --
calls = []; reply = 'ok';
{
  const e = env();
  const w = await W.weather(e);
  eq('temperature is rounded, not raw', w.now, 18);
  eq('the code becomes a word', w.text, 'пасмурно');
  eq("today's range comes from daily", [w.today.high, w.today.low], [19, 16]);
  eq("and today's word too", w.today.text, 'дождь');
  eq('tomorrow is carried as well', [w.tomorrow.high, w.tomorrow.low, w.tomorrow.text], [23, 17, 'ясно']);
  eq('the place is a label', w.place, 'Барселона');
  eq('a shape is chosen for the sky', w.icon, 'cloud');
  eq('and one for each forecast day', [w.today.icon, w.tomorrow.icon], ['rain', 'clear']);

  const url = new URL(calls[0]);
  eq('asked Open-Meteo for Barcelona', url.searchParams.get('latitude'), '41.3874');
  eq('with the family timezone', url.searchParams.get('timezone'), 'Europe/Madrid');
  ok('and asks whether it is daylight', url.searchParams.get('current').includes('is_day'));
  eq('and two days', url.searchParams.get('forecast_days'), '2');
  ok('no API key is involved', !/key|token|appid/i.test(calls[0]), calls[0]);
}

// --------------------------------------------------------- the icon table ---
{
  // Every WMO code the text table names must also have a shape, or the wall
  // shows a word with a blank where the picture goes.
  const missing = Object.keys(W.WMO).filter(c => !W.WMO_ICON[c]);
  eq('every described code has a drawing', missing, []);
  const shapes = new Set(Object.values(W.WMO_ICON));
  eq('and they resolve to the seven shapes the page knows',
     [...shapes].sort(), ['clear', 'cloud', 'fog', 'partly', 'rain', 'snow', 'storm']);

  // The page's own table, read from the file, must cover each of them plus the
  // two after-dark variants.
  const page = await (await import('node:fs/promises'))
    .readFile(new URL('../src/wall.html', import.meta.url), 'utf8');
  const drawn = [...page.matchAll(/^    ([a-zA-Z]+):$|^    ([a-zA-Z]+):\n/gm)]
    .map(m => m[1] || m[2]);
  const inPage = new Set([...page.matchAll(/\n    ([a-zA-Z]+):\s*\n?\s*'/g)].map(m => m[1]));
  for (const shape of shapes) ok(`the page draws «${shape}»`, inPage.has(shape), [...inPage].join(','));
  ok('and has a moon for a clear night', inPage.has('moon'));
  ok('and a clouded moon', inPage.has('partlyNight'));
}

// --- day and night ----------------------------------------------------------
{
  const e = env();
  reply = 'ok'; calls = [];
  body.current.is_day = 1;
  eq('daylight is reported as such', (await W.weather(e)).day, true);

  const e2 = env();
  body.current.is_day = 0;
  eq('and night too', (await W.weather(e2)).day, false);
  body.current.is_day = 1;
}

// ------------------------------------------------------------------ caching --
{
  const e = env();
  calls = [];
  await W.weather(e);
  eq('first call goes out', calls.length, 1);
  await W.weather(e);
  await W.weather(e);
  eq('the next ones are served from KV', calls.length, 1);
  ok('and a long-lived copy is kept', !!(await e.CHATS.get('weather:41.3874,2.1686:last', 'json')));
}

// --------------------------------------------------- degrading, not failing --
for (const mode of ['down', 'throw']) {
  const e = env();
  reply = 'ok'; calls = [];
  const good = await W.weather(e);
  await e.CHATS.delete('weather:41.3874,2.1686');     // the 15-minute copy expires
  reply = mode;
  const stale = await W.weather(e);
  eq(`Open-Meteo ${mode}: the last good reading is used`, stale.now, good.now);
}
{
  const e = env();
  reply = 'down';
  eq('with nothing ever cached it is null, not an error', await W.weather(e), null);
}

// ------------------------------------------------- it reaches the wall page --
{
  reply = 'ok';
  const e = env({ WALL_KEY: 'k', TODOIST_API_TOKEN: 't', TODOIST_PROJECT_ID: 'p' });
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    const s = String(u);
    if (s.includes('api.todoist.com')) {
      return new Response(JSON.stringify(s.endsWith('/sync')
        ? { collaborators: [], collaborator_states: [] } : { results: [], next_cursor: null }),
        { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(u, i);
  };
  const res = await W.apiWall(new Request('https://x/api/wall?k=k'), e);
  const j = await res.json();
  globalThis.fetch = realFetch;
  eq('the wall payload carries it', j.weather.now, 18);
  ok('alongside the tasks it already had', 'tasks' in j && 'days' in j);
}

// A wall must still render when the weather is missing.
{
  const e = env({ WALL_KEY: 'k', TODOIST_API_TOKEN: 't', TODOIST_PROJECT_ID: 'p' });
  reply = 'down';
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u, i) => {
    const s = String(u);
    if (s.includes('api.todoist.com')) {
      return new Response(JSON.stringify(s.endsWith('/sync')
        ? { collaborators: [], collaborator_states: [] } : { results: [], next_cursor: null }),
        { headers: { 'content-type': 'application/json' } });
    }
    return realFetch(u, i);
  };
  const j = await (await W.apiWall(new Request('https://x/api/wall?k=k'), e)).json();
  globalThis.fetch = realFetch;
  eq('no weather is null, and the rest still arrives', j.weather, null);
  ok('tasks unaffected', Array.isArray(j.tasks));
}

// ------------------------------------------------------------ somewhere else --
{
  reply = 'ok'; calls = [];
  const e = env({ WEATHER_LAT: '55.75', WEATHER_LON: '37.62', WEATHER_PLACE: 'Москва' });
  const w = await W.weather(e);
  eq('coordinates are configurable', new URL(calls[0]).searchParams.get('latitude'), '55.75');
  eq('and so is the label', w.place, 'Москва');
  ok('cached per location', !!(await e.CHATS.get('weather:55.75,37.62', 'json')));
}

done();
