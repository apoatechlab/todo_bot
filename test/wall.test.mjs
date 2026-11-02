/**
 * /api/wall: the tablet's data. Locked by WALL_KEY, today in clock order,
 * overdue and tomorrow alongside.
 */
import { makeKV } from './helpers/kv.mjs';
import { loadWorker, harness } from './helpers/load.mjs';

const W = await loadWorker();
const { ok, eq, done } = harness();

const tz = 'Europe/Madrid';
const today = W.localParts(tz).date;
const tomorrow = W.shiftDate(today, 1);
const yesterday = W.shiftDate(today, -1);

const tasks = [
  { id: '1', content: 'молоко', due: { date: today } },
  { id: '2', content: 'стоматолог', due: { date: `${today}T12:15:00` }, responsible_uid: 7 },
  { id: '3', content: 'почта', due: { date: `${today}T09:30:00` } },
  { id: '4', content: 'счёт', due: { date: yesterday } },
  { id: '5', content: 'собрание', due: { date: `${tomorrow}T18:00:00` } },
  { id: '6', content: 'кран' },
];
globalThis.fetch = async u => {
  const J = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (String(u).endsWith('/sync')) return J({ collaborators: [{ id: 7, full_name: 'Антон Помельников' }], collaborator_states: [{ project_id: 'p', user_id: 7 }] });
  return J({ results: tasks, next_cursor: null });
};
const kv = makeKV();
await kv.put('marks', JSON.stringify([{ from: today, to: tomorrow, kind: 'school-off' }]));
const env = { CHATS: kv, TODOIST_API_TOKEN: 't', TODOIST_PROJECT_ID: 'p', WALL_KEY: 'sesame' };
const call = (k, e = env) => W.apiWall(new Request(`https://x/api/wall${k === null ? '' : `?k=${k}`}`), e);

eq('no key → 403', (await call(null)).status, 403);
eq('wrong key → 403', (await call('nope')).status, 403);
eq('unset WALL_KEY → off', (await call('sesame', { ...env, WALL_KEY: '' })).status, 503);

const r = await call('sesame');
eq('right key → 200', r.status, 200);
const d = await r.json();
eq('today in clock order, untimed last', d.tasks.map(t => t.content), ['почта', 'стоматолог', 'молоко']);
eq('time sliced', d.tasks[0].time, '09:30');
eq('assignee first name', d.tasks[1].who, 'Антон');
eq('overdue', d.overdue.map(t => t.content), ['счёт']);
eq('tomorrow', d.tomorrow.map(t => t.content), ['собрание']);
eq('undated left out', [...d.tasks, ...d.overdue, ...d.tomorrow].some(t => t.content === 'кран'), false);
eq('mark today', d.mark?.label, 'Нет школы');
eq('mark tomorrow', d.tomorrowMark?.label, 'Нет школы');

done();
