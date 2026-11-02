/**
 * /maybe: undated tasks on request, never repeating the last round while
 * the pile has alternatives.
 */
import { makeKV } from './helpers/kv.mjs';
import { loadWorker, harness } from './helpers/load.mjs';

const W = await loadWorker();
const { ok, eq, done } = harness();

let tasks = [];
const sent = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const J = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (u.includes('/sendMessage')) { sent.push(JSON.parse(init.body)); return J({ ok: true, result: {} }); }
  if (u.startsWith('https://api.telegram.org/bot')) return J({ ok: true, result: {} });
  if (u.endsWith('/sync')) return J({ collaborators: [], collaborator_states: [] });
  return J({ results: tasks, next_cursor: null });
};
const env = { CHATS: makeKV(), TELEGRAM_BOT_TOKEN: 't', TODOIST_API_TOKEN: 't', TODOIST_PROJECT_ID: 'p' };

tasks = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `u${i}`, content: `task ${i}` })),
  { id: 'd1', content: 'dated', due: { date: '2026-11-03' } },
];
await W.suggestUndated(env, 1);
const first = sent.at(-1).text;
ok('header', first.includes('может, сегодня?'), first);
eq('five picks', (first.match(/•/g) || []).length, 5);
ok('dated tasks left out', !first.includes('dated'));
ok('remainder counted', first.includes('Ещё 7 без срока'), first);

await W.suggestUndated(env, 1);
const ids = t => [...t.matchAll(/task\/(u\d+)/g)].map(m => m[1]);
ok('second round avoids the first', ids(sent.at(-1).text).every(id => !ids(first).includes(id)));

tasks = [{ id: 'd1', content: 'dated', due: { date: '2026-11-03' } }];
await W.suggestUndated(env, 1);
ok('empty pile still answers', sent.at(-1).text.includes('Задач без срока нет'));

done();
