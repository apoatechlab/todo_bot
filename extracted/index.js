/**
 * Family task bot — Cloudflare Workers edition.
 * Telegram webhook -> (voice: Groq Whisper) -> Claude tool use -> Todoist project.
 *
 * Bindings expected:
 *   KV namespace: CHATS
 *   Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ANTHROPIC_API_KEY,
 *            TODOIST_API_TOKEN, GROQ_API_KEY
 *   Vars:    TODOIST_PROJECT_ID, TZ_NAME, TODOIST_DUE_LANG, ALLOWED_CHAT_IDS, ALLOW_DELETE
 */

const TD = 'https://api.todoist.com/api/v1';
const MODEL = 'claude-sonnet-4-6';

// ============================================================ entrypoint ====
export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('ok');

    // Telegram proves it's Telegram by echoing the secret we registered.
    if (request.headers.get('X-Telegram-Bot-Api-Secret-Token') !== env.TELEGRAM_WEBHOOK_SECRET) {
      return new Response('forbidden', { status: 403 });
    }

    const update = await request.json().catch(() => null);

    // Return 200 straight away — Telegram retries anything slower, which would
    // duplicate tasks. Real work continues in the background.
    ctx.waitUntil(handleUpdate(update, env).catch(err => console.error('handler', err.stack)));
    return new Response('ok');
  },
};

async function handleUpdate(update, env) {
  const msg = update?.message;
  if (!msg) return;

  const chatId = String(msg.chat.id);
  const allowed = (env.ALLOWED_CHAT_IDS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (allowed.length && !allowed.includes(chatId)) {
    console.warn('blocked chat', chatId, msg.from?.username);
    return;
  }

  let text = msg.text;
  const voice = msg.voice || msg.audio;
  if (voice) {
    await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
    text = await transcribe(env, voice.file_id);
  }
  if (!text) return;

  if (text.startsWith('/start') || text.startsWith('/help')) {
    return tg(env, 'sendMessage', {
      chat_id: chatId,
      text: 'Пиши или наговаривай: «купить молоко завтра», «перенеси дантиста на пятницу», «садик — сделано», «что на сегодня?»',
    });
  }
  if (text.startsWith('/reset')) {
    await env.CHATS.delete(`hist:${chatId}`);
    return tg(env, 'sendMessage', { chat_id: chatId, text: 'Контекст очищен.' });
  }
  if (text.startsWith('/rules')) {
    if (text.includes('reset')) {
      await env.CHATS.delete('rules');
      return tg(env, 'sendMessage', { chat_id: chatId, text: 'Правила сброшены на стандартные.' });
    }
    const rules = await getRules(env);
    return tg(env, 'sendMessage', {
      chat_id: chatId,
      text: `*Правила бота:*\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n_Скажи или напиши «правило: …» чтобы добавить, «убери правило N» чтобы удалить._`,
      parse_mode: 'Markdown',
    });
  }

  // In a group, who spoke matters — Claude needs it to resolve "я сделал".
  const speaker = msg.from?.first_name || 'unknown';
  const isGroup = msg.chat.type !== 'private';
  const userTurn = isGroup ? `[${speaker}]: ${text}` : text;

  await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const reply = await converse(env, chatId, userTurn);
    await tg(env, 'sendMessage', {
      chat_id: chatId,
      text: (voice ? `🎤 _${text}_\n\n` : '') + reply,
      parse_mode: 'Markdown',
      reply_to_message_id: isGroup ? msg.message_id : undefined,
    });
  } catch (e) {
    console.error(e.stack);
    await tg(env, 'sendMessage', { chat_id: chatId, text: `⚠️ ${e.message}`.slice(0, 500) });
  }
}

// =============================================================== todoist ====
async function todoist(env, path, { method = 'GET', body } = {}) {
  const r = await fetch(TD + path, {
    method,
    headers: {
      Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(method !== 'GET' ? { 'X-Request-Id': crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`Todoist ${method} ${path} → ${r.status} ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

async function listTasks(env) {
  const out = [];
  let cursor = null;
  // Cap pages: the free plan allows 50 subrequests per invocation in total.
  for (let page = 0; page < 3; page++) {
    const q = new URLSearchParams({ project_id: env.TODOIST_PROJECT_ID, limit: '200' });
    if (cursor) q.set('cursor', cursor);
    const res = await todoist(env, `/tasks?${q}`);
    out.push(...(res.results ?? res));
    cursor = res.next_cursor ?? null;
    if (!cursor) break;
  }
  return out;
}

async function assertInProject(env, taskId) {
  const t = await todoist(env, `/tasks/${taskId}`);
  if (String(t.project_id) !== String(env.TODOIST_PROJECT_ID)) {
    throw new Error('Task is outside the allowed project — refused.');
  }
  return t;
}

/** Roster changes ~never. Cache it for a day so we skip a /sync round-trip. */
async function roster(env) {
  const key = `roster:${env.TODOIST_PROJECT_ID}`;
  const cached = await env.CHATS.get(key, 'json');
  if (cached) return cached;
  try {
    const r = await fetch(`${TD}/sync`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        sync_token: '*',
        resource_types: '["collaborators","collaborator_states"]',
      }),
    });
    const d = await r.json();
    const inProject = new Set(
      (d.collaborator_states || [])
        .filter(s => String(s.project_id) === String(env.TODOIST_PROJECT_ID))
        .map(s => String(s.user_id)),
    );
    const people = (d.collaborators || [])
      .filter(c => inProject.has(String(c.id)))
      .map(c => ({ id: String(c.id), name: c.full_name }));
    await env.CHATS.put(key, JSON.stringify(people), { expirationTtl: 86400 });
    return people;
  } catch { return []; }
}

// ================================================================= tools ====
const tools = [
  {
    name: 'add_task',
    description: 'Create a new task in the family project.',
    input_schema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: "Task title, in the user's language." },
        due_string: { type: 'string', description: 'Due date in the user\'s own words, e.g. "завтра в 18:00", "cada lunes". Omit if none was mentioned.' },
        description: { type: 'string' },
        priority: { type: 'integer', description: '1 = normal … 4 = urgent' },
        labels: { type: 'array', items: { type: 'string' } },
        assignee_id: { type: 'string', description: 'Member id from the roster, if someone was named.' },
      },
      required: ['content'],
    },
  },
  {
    name: 'update_task',
    description: 'Change title, due date, priority or assignee. Use this to postpone.',
    input_schema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        content: { type: 'string' },
        due_string: { type: 'string', description: '"next friday", or "no date" to clear.' },
        priority: { type: 'integer' },
        assignee_id: { type: 'string' },
      },
      required: ['task_id'],
    },
  },
  {
    name: 'complete_task',
    description: 'Mark a task done.',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'delete_task',
    description: 'Permanently delete. Only when the user explicitly says delete/remove, not "done".',
    input_schema: { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] },
  },
  {
    name: 'search_tasks',
    description: 'Look up tasks that were not in the visible list — e.g. far-future ones. Returns matches by keyword.',
    input_schema: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  {
    name: 'add_house_rule',
    description: 'Save a new standing rule about how you should behave. Use when the person says "from now on…", "always…", "never…", "правило:", "запомни, что…". Not for one-off instructions.',
    input_schema: {
      type: 'object',
      properties: {
        rule: { type: 'string', description: 'The rule as a short imperative sentence, in the language it was given.' },
      },
      required: ['rule'],
    },
  },
  {
    name: 'remove_house_rule',
    description: 'Delete a standing rule by its number, as shown in the House rules list.',
    input_schema: {
      type: 'object',
      properties: { number: { type: 'integer' } },
      required: ['number'],
    },
  },
];

async function runTool(env, name, args) {
  switch (name) {
    case 'add_task': {
      const t = await todoist(env, '/tasks', {
        method: 'POST',
        body: {
          project_id: env.TODOIST_PROJECT_ID,
          content: args.content,
          description: args.description,
          due_string: args.due_string,
          due_lang: args.due_string ? (env.TODOIST_DUE_LANG || 'ru') : undefined,
          priority: args.priority,
          labels: args.labels,
          responsible_uid: args.assignee_id,
        },
      });
      return { ok: true, task: compact(t) };
    }
    case 'update_task': {
      await assertInProject(env, args.task_id);
      const t = await todoist(env, `/tasks/${args.task_id}`, {
        method: 'POST',
        body: {
          content: args.content,
          due_string: args.due_string,
          due_lang: args.due_string ? (env.TODOIST_DUE_LANG || 'ru') : undefined,
          priority: args.priority,
          responsible_uid: args.assignee_id,
        },
      });
      return { ok: true, task: compact(t) };
    }
    case 'complete_task': {
      const t = await assertInProject(env, args.task_id);
      await todoist(env, `/tasks/${args.task_id}/close`, { method: 'POST' });
      return { ok: true, completed: t.content };
    }
    case 'delete_task': {
      const t = await assertInProject(env, args.task_id);
      if (env.ALLOW_DELETE !== 'true') {
        await todoist(env, `/tasks/${args.task_id}/close`, { method: 'POST' });
        return { ok: true, note: 'Deletion disabled; completed instead.', task: t.content };
      }
      await todoist(env, `/tasks/${args.task_id}`, { method: 'DELETE' });
      return { ok: true, deleted: t.content };
    }
    case 'search_tasks': {
      const all = await listTasks(env);
      const q = args.query.toLowerCase();
      return { matches: all.filter(t => t.content.toLowerCase().includes(q)).map(compact).slice(0, 20) };
    }
    case 'add_house_rule': {
      const rules = await getRules(env);
      if (rules.length >= 25) return { error: 'Rule list is full (25). Remove one first.' };
      rules.push(args.rule.trim());
      await putRules(env, rules);
      return { ok: true, number: rules.length, rules };
    }
    case 'remove_house_rule': {
      const rules = await getRules(env);
      const i = args.number - 1;
      if (i < 0 || i >= rules.length) return { error: `No rule ${args.number}. There are ${rules.length}.` };
      const [gone] = rules.splice(i, 1);
      await putRules(env, rules);
      return { ok: true, removed: gone, rules };
    }
    default:
      return { error: `unknown tool ${name}` };
  }
}

function compact(t) {
  return {
    id: t.id,
    content: t.content,
    due: t.due?.string ?? null,
    priority: t.priority,
    assignee: t.responsible_uid ?? null,
  };
}

// =============================================== context assembly (layers) ==
/**
 * Only put tasks in the prompt that the user could plausibly mean right now.
 * Everything else stays reachable via the search_tasks tool.
 */
function relevantTasks(tasks, horizonDays = 21, cap = 70) {
  const now = Date.now();
  const horizon = now + horizonDays * 864e5;
  const dueTime = t => {
    const d = t.due?.date;
    if (!d) return null;
    return Date.parse(d.length === 10 ? `${d}T23:59:59Z` : d);
  };
  const scored = tasks.map(t => {
    const dt = dueTime(t);
    let bucket;
    if (dt === null) bucket = 2;              // undated — often the ones people mean
    else if (dt < now) bucket = 0;            // overdue — highest salience
    else if (dt <= horizon) bucket = 1;       // upcoming
    else bucket = 3;                          // far future — usually noise
    return { t, bucket, dt: dt ?? Infinity };
  });
  return scored
    .sort((a, b) => a.bucket - b.bucket || a.dt - b.dt)
    .filter(s => s.bucket !== 3)
    .slice(0, cap)
    .map(s => compact(s.t));
}

/** Seeded on first run; editable afterwards from Telegram by text or voice. */
const DEFAULT_RULES = [
  'Не ставь срок, если он не назван явно — задача без даты лучше, чем выдуманная дата.',
  '«Вечером», «на выходных», «завтра» — это явные сроки, передавай их как есть.',
  'Приоритет по умолчанию обычный. p4 ставь только если сказано «срочно» или «горит».',
  'Формулируй задачу коротко и с глаголом: «купить молоко», а не «молоко надо купить».',
  'Перед созданием проверь список: если похожая задача уже есть, обнови её срок вместо новой.',
  'Если названо имя члена семьи — назначь задачу на него.',
  'Голосовые часто содержат оговорки и «эээ» — вытаскивай смысл, не переноси мусор в название.',
];

async function getRules(env) {
  const stored = await env.CHATS.get('rules', 'json');
  return stored ?? DEFAULT_RULES.slice();
}
async function putRules(env, rules) {
  await env.CHATS.put('rules', JSON.stringify(rules));
}

function systemPrompt(env, tasks, people, hidden, rules) {
  const tz = env.TZ_NAME || 'Europe/Madrid';
  return `You are the household task assistant for a family. You operate on exactly ONE Todoist project — every task you create goes there automatically, and you cannot touch anything outside it.
Now: ${new Date().toLocaleString('en-GB', { timeZone: tz })} (${tz}).

How you work (fixed):
- Turn what the person says into tool calls. Don't ask permission for ordinary adds, postpones or completions — just do them.
- One message may hold several instructions; handle all of them.
- Pass dates through verbatim in due_string, in the person's own words. Todoist parses natural language itself — never compute a date yourself.
- "done / сделал / listo" → complete_task. "delete / удали / borra" → delete_task.
- Messages in a group are prefixed with [Name]. Use that to resolve "мне", "я сделал", and to pick an assignee.
- If a task isn't in the list below, call search_tasks before saying it doesn't exist.
- If a reference is truly ambiguous, ask one short question instead of guessing.
- When the person states a standing preference ("always…", "never…", "с этого момента…", "правило:"), call add_house_rule instead of just agreeing.
- Reply in the language the person wrote in, one or two lines, stating only what changed. No preamble.

House rules (set by the family; follow them unless they conflict with the fixed behaviour above):
${rules.length ? rules.map((r, i) => `${i + 1}. ${r}`).join('\n') : '(none set)'}

Members:
${people.length ? people.map(p => `- ${p.name} (id ${p.id})`).join('\n') : '- (personal project, no members)'}

Open tasks — overdue first, then upcoming, then undated (id | title | due):
${tasks.length ? tasks.map(t => `${t.id} | ${t.content} | ${t.due ?? '—'}`).join('\n') : '(none)'}
${hidden > 0 ? `\n(${hidden} further tasks are dated beyond the horizon and not shown — use search_tasks to reach them.)` : ''}`;
}

// ================================================================ claude ====
async function converse(env, chatId, userTurn) {
  const [all, people, history, rules] = await Promise.all([
    listTasks(env),
    roster(env),
    env.CHATS.get(`hist:${chatId}`, 'json'),
    getRules(env),
  ]);

  const visible = relevantTasks(all);
  const system = systemPrompt(env, visible, people, all.length - visible.length, rules);
  const messages = [...(history?.messages ?? []), { role: 'user', content: userTurn }];

  for (let hop = 0; hop < 5; hop++) {
    const res = await claude(env, system, messages);
    messages.push({ role: 'assistant', content: res.content });

    if (res.stop_reason !== 'tool_use') {
      const reply = res.content.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();
      await saveHistory(env, chatId, messages);
      return reply || 'Готово.';
    }

    const results = [];
    for (const block of res.content.filter(b => b.type === 'tool_use')) {
      let out;
      try { out = await runTool(env, block.name, block.input); }
      catch (e) { out = { error: String(e.message).slice(0, 300) }; }
      console.log('tool', block.name, JSON.stringify(block.input));
      results.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(out) });
    }
    messages.push({ role: 'user', content: results });
  }
  return 'Слишком много шагов — остановился.';
}

async function claude(env, system, messages) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, tools, messages }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

/**
 * Persist text only. Tool blocks are dropped deliberately: they are bulky and
 * they embed task ids that may be stale by the next message.
 */
async function saveHistory(env, chatId, messages) {
  const trimmed = messages
    .map(m => ({
      role: m.role,
      content: typeof m.content === 'string'
        ? m.content
        : m.content.filter(b => b.type === 'text').map(b => b.text).join('\n'),
    }))
    .filter(m => m.content.trim())
    .slice(-6); // three exchanges
  await env.CHATS.put(`hist:${chatId}`, JSON.stringify({ messages: trimmed }), {
    expirationTtl: 1800, // 30 min — a new errand shouldn't inherit the last one
  });
}

// ============================================================== telegram ====
function tgBase(env) { return `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`; }

async function tg(env, method, params) {
  const r = await fetch(`${tgBase(env)}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(params),
  });
  return r.json();
}

async function transcribe(env, fileId) {
  if (!env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set — voice disabled.');
  const { result } = await (await fetch(`${tgBase(env)}/getFile?file_id=${fileId}`)).json();
  const audio = await (await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${result.file_path}`)).arrayBuffer();

  const form = new FormData();
  form.append('file', new Blob([audio]), 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).text;
}
