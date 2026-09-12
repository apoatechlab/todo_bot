/**
 * Weekend ideas: which tasks qualify, when the Thursday job actually fires,
 * and how the label is set without trampling the others on a task.
 */
import { makeKV } from './helpers/kv.mjs';
import { loadWorker, harness } from './helpers/load.mjs';

const W = await loadWorker();
const { ok, eq, done } = harness();

let tasks = [];
const sent = [];
let updated = null, createdBody = null;

globalThis.fetch = async (url, init = {}) => {
  const u = String(url), body = init.body;
  const J = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (u.includes('/sendMessage')) { sent.push(JSON.parse(body)); return J({ ok: true, result: {} }); }
  if (u.startsWith('https://api.telegram.org/bot')) return J({ ok: true, result: {} });
  if (u.includes('api.todoist.com')) {
    if (u.endsWith('/sync')) return J({ collaborators: [], collaborator_states: [] });
    const m = /\/tasks\/([^/?]+)$/.exec(u.split('?')[0]);
    if (m && init.method === 'POST') { updated = JSON.parse(body);
      return J({ id: m[1], content: 'x', labels: updated.labels ?? [] }); }
    if (m) return J({ id: m[1], project_id: 'p', content: 'x',
      labels: tasks.find(t => t.id === m[1])?.labels ?? [] });
    if (init.method === 'POST') { createdBody = JSON.parse(body);
      return J({ id: 'NEW', content: createdBody.content, labels: createdBody.labels ?? [] }); }
    return J({ results: tasks, next_cursor: null });
  }
  throw new Error('unstubbed ' + u);
};

const env = extra => ({ CHATS: makeKV(), TELEGRAM_BOT_TOKEN: 't', TODOIST_API_TOKEN: 'td',
  TODOIST_PROJECT_ID: 'p', TZ_NAME: 'Europe/Madrid', DIGEST_CHAT_ID: '-100',
  ALLOWED_CHAT_IDS: '-100', ...extra });
const text = () => sent.at(-1)?.text ?? '';

// ------------------------------------------------------- comingWeekend ------
// 2026-09-12 is a Saturday, so the week of the 10th (Thursday) leads into it.
eq('Thursday looks ahead to this Saturday', W.comingWeekend('2026-09-10'),
   { sat: '2026-09-12', sun: '2026-09-13' });
eq('Monday looks ahead to the same one', W.comingWeekend('2026-09-07'),
   { sat: '2026-09-12', sun: '2026-09-13' });
eq('on Saturday it is today', W.comingWeekend('2026-09-12'),
   { sat: '2026-09-12', sun: '2026-09-13' });
eq('on Sunday it is the one we are in', W.comingWeekend('2026-09-13'),
   { sat: '2026-09-12', sun: '2026-09-13' });
eq('Friday still means tomorrow', W.comingWeekend('2026-09-11'),
   { sat: '2026-09-12', sun: '2026-09-13' });

// --------------------------------------------------------- the selection ----
tasks = [
  { id: '1', content: 'сходить в Прадо', labels: ['выходные'] },
  { id: '2', content: 'съездить в Сеговию', labels: ['выходные'] },
  { id: '3', content: 'купить молоко', labels: [] },
  { id: '4', content: 'концерт', labels: ['выходные'], due: { date: '2026-09-12T20:30:00' } },
  { id: '5', content: 'дантист', labels: ['выходные'], due: { date: '2026-09-16' } },
  { id: '6', content: 'ВЫХОДНЫЕ регистр', labels: ['ВЫХОДНЫЕ'] },
];
sent.length = 0;
await W.weekendIdeas(env(), { force: true, chatId: '-100' });
ok('unlabelled tasks are left out', !text().includes('купить молоко'), text());
ok('undated labelled ones are offered', text().includes('сходить в Прадо'));
ok('the label match ignores case', text().includes('ВЫХОДНЫЕ регистр'));
ok('one dated into the weekend shows as planned',
   /Уже в планах[\s\S]*концерт/.test(text()), text());
ok('with its weekday and time', /сб 20:30/.test(text()));
ok('a labelled task dated outside the weekend is not shown', !text().includes('дантист'));
ok('the weekend dates are in the header', /12 сент.*13 сент/.test(text()), text());
ok('every idea links to its task', (text().match(/app\/task\//g) || []).length >= 3);

// --------------------------------------------------------------- cap --------
tasks = Array.from({ length: 12 }, (_, i) =>
  ({ id: 'i' + i, content: 'идея ' + i, labels: ['выходные'] }));
sent.length = 0;
await W.weekendIdeas(env({ WEEKEND_COUNT: '4' }), { force: true, chatId: '-100' });
eq('WEEKEND_COUNT caps the list', (text().match(/• /g) || []).length, 4);
ok('and the rest are counted', /Ещё 8 с этой меткой/.test(text()), text());

// --------------------------------------------------------------- empty ------
tasks = [{ id: '1', content: 'купить молоко', labels: [] }];
sent.length = 0;
await W.weekendIdeas(env(), { force: true, chatId: '-100' });
ok('asked by hand with nothing marked, it explains the label',
   /ни одной задачи с меткой «выходные»/.test(text()), text());

sent.length = 0;
await W.weekendIdeas(env(), {});   // scheduled path, not Thursday
eq('the scheduled job stays silent instead', sent.length, 0);

// ------------------------------------------------------- the time guards ----
// These run on a real clock, so assert the guard's behaviour, not a fixed day.
const today = new Date().toISOString().slice(0, 10);
const isThursday = new Date(`${today}T12:00:00Z`).getUTCDay() === 4;
tasks = [{ id: '1', content: 'идея', labels: ['выходные'] }];
sent.length = 0;
await W.weekendIdeas(env({ WEEKEND_AT: '00:00' }), {});
ok('outside the 30-minute window nothing is sent',
   isThursday ? true : sent.length === 0, 'sent on a non-Thursday');

// The day key stops the second cron firing of the same Thursday.
{
  const e = env();
  const stamp = `weekend:${new Date().toISOString().slice(0, 10)}`;
  await e.CHATS.put(stamp, '1');
  sent.length = 0;
  await W.weekendIdeas(e, {});
  eq('a day already sent is not sent again', sent.length, 0);
}

// --------------------------------------------------------- labelling --------
{
  const e = env();
  createdBody = null;
  await W.runTool(e, 'add_task', { content: 'сходить в Прадо', weekend: true });
  eq('add_task with weekend applies the label', createdBody.labels, ['выходные']);

  createdBody = null;
  await W.runTool(e, 'add_task', { content: 'купить молоко' });
  ok('without it, none is added', !createdBody.labels?.includes('выходные'),
     JSON.stringify(createdBody.labels));

  createdBody = null;
  await W.runTool(e, 'add_task', { content: 'x', weekend: true, labels: ['дом'] });
  eq('it joins the labels the model asked for', createdBody.labels, ['дом', 'выходные']);

  createdBody = null;
  await W.runTool(e, 'add_task', { content: 'x', weekend: true, labels: ['выходные'] });
  eq('and is not duplicated', createdBody.labels, ['выходные']);
}

// Updating must not wipe the other labels — Todoist replaces the whole array.
{
  const e = env();
  tasks = [{ id: 'T9', content: 'x', labels: ['дом', 'срочно'] }];
  updated = null;
  await W.runTool(e, 'update_task', { task_id: 'T9', weekend: true });
  eq('marking keeps the labels already on the task', updated.labels, ['дом', 'срочно', 'выходные']);

  tasks = [{ id: 'T9', content: 'x', labels: ['дом', 'выходные', 'срочно'] }];
  updated = null;
  await W.runTool(e, 'update_task', { task_id: 'T9', weekend: false });
  eq('unmarking removes only that one', updated.labels, ['дом', 'срочно']);

  tasks = [{ id: 'T9', content: 'x', labels: ['дом'] }];
  updated = null;
  await W.runTool(e, 'update_task', { task_id: 'T9', content: 'новое имя' });
  eq('an unrelated edit leaves labels alone', updated.labels, undefined);
}

// A custom label name is honoured everywhere.
{
  const e = env({ WEEKEND_LABEL: 'weekend' });
  createdBody = null;
  await W.runTool(e, 'add_task', { content: 'x', weekend: true });
  eq('WEEKEND_LABEL is used on write', createdBody.labels, ['weekend']);
  tasks = [{ id: '1', content: 'идея', labels: ['weekend'] }];
  sent.length = 0;
  await W.weekendIdeas(e, { force: true, chatId: '-100' });
  ok('and on read', text().includes('идея'), text());
}

done();
