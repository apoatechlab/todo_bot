/**
 * Every command must finish sending before handleUpdate resolves.
 *
 * ctx.waitUntil settles when handleUpdate does, and the runtime may then cancel
 * anything still in flight. An un-awaited reply is a race the bot loses exactly
 * when the turn was slow — which is when the reply matters most.
 */
import { makeKV } from './helpers/kv.mjs';
import { loadWorker, harness } from './helpers/load.mjs';

const W = await loadWorker();
const { ok, eq, done } = harness();

// Every sendMessage resolves only when released, so anything not awaited shows
// up as a reply that had not landed by the time handleUpdate returned.
let pending = [];
const landed = [];
const release = () => { const p = pending; pending = []; p.forEach(r => r()); };

globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  const J = o => new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } });
  if (u.includes('/sendMessage')) {
    const body = JSON.parse(init.body);
    await new Promise(r => pending.push(r));      // held open until released
    landed.push(body);
    return J({ ok: true, result: { message_id: 1 } });
  }
  if (u.startsWith('https://api.telegram.org/bot')) return J({ ok: true, result: {} });
  if (u === 'https://oauth2.googleapis.com/token') return J({ access_token: 'a', expires_in: 3600 });
  if (u.startsWith('https://www.googleapis.com/drive/v3/files')) {
    if ((init.method || 'GET') === 'GET') return J({ files: [] });
    return J({ id: 'dir1' });
  }
  if (u.includes('api.todoist.com')) {
    if (u.endsWith('/sync')) return J({ collaborators: [], collaborator_states: [] });
    return J({ results: [], next_cursor: null });
  }
  if (u === 'https://api.anthropic.com/v1/messages') {
    return J({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ок' }] });
  }
  throw new Error('unstubbed ' + u);
};

const env = () => ({ CHATS: makeKV(), TELEGRAM_BOT_TOKEN: 't', ANTHROPIC_API_KEY: 'k',
  TODOIST_API_TOKEN: 'td', TODOIST_PROJECT_ID: 'p', TZ_NAME: 'Europe/Madrid',
  ALLOWED_CHAT_IDS: '-100', DIGEST_CHAT_ID: '-100',
  GOOGLE_CLIENT_ID: 'c', GOOGLE_CLIENT_SECRET: 's', GOOGLE_REFRESH_TOKEN: 'r' });

/** Run a command and report whether every reply had landed when it returned. */
async function commandLandsItsReply(text) {
  landed.length = 0; pending = [];
  let settled = false;
  const turn = W.handleUpdate({ message: { chat: { id: -100, type: 'supergroup' },
    from: { first_name: 'Антон' }, message_id: 1, text } }, env())
    .then(() => { settled = true; });

  // Let the handler run up to the point where it is blocked on the send.
  for (let i = 0; i < 40 && !pending.length && !settled; i++) await new Promise(r => setTimeout(r, 1));
  const settledBeforeSending = settled && landed.length === 0;

  // Keep releasing while the turn runs: a command may send more than once
  // (/docs fix acknowledges, then reports), and awaiting the turn first would
  // deadlock against the second send.
  const pump = setInterval(release, 1);
  await turn;
  clearInterval(pump);
  release();
  return { settledBeforeSending, count: landed.length };
}

for (const cmd of ['/help', '/start', '/reset', '/rules', '/rules reset', '/school',
                   '/school reset', '/docs', '/docs fix', '/weekend', 'привет']) {
  const r = await commandLandsItsReply(cmd);
  ok(`${cmd} waits for its reply`, !r.settledBeforeSending,
     'handleUpdate resolved with the send still in flight');
  ok(`${cmd} actually replies`, r.count > 0, 'nothing sent');
}

// And the source carries no orphaned sends at all.
const src = await (await import('node:fs/promises')).readFile(
  new URL('../src/index.js', import.meta.url), 'utf8');
const orphans = src.split('\n')
  .map((l, i) => [i + 1, l])
  .filter(([, l]) => /return void say\(/.test(l) && !/^\s*\*/.test(l));
eq('no un-awaited say() remains in the source', orphans.map(([n]) => n), []);

done();
