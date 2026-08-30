/**
 * Family task bot — Cloudflare Workers edition.
 * Telegram webhook -> (voice: Groq Whisper) -> Claude tool use -> Todoist project.
 *
 * Bindings expected:
 *   KV namespace: CHATS
 *   Secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_WEBHOOK_SECRET, ANTHROPIC_API_KEY,
 *            TODOIST_API_TOKEN, GROQ_API_KEY
 *   Vars:    TODOIST_PROJECT_ID, TZ_NAME, TODOIST_DUE_LANG, ALLOWED_CHAT_IDS,
 *            ALLOW_DELETE, CLAUDE_MODEL, CLAUDE_EFFORT,
 *            DIGEST_CHAT_ID, DIGEST_AT, DIGEST_SKIP_EMPTY, SUGGEST_COUNT,
 *            ALERT_LEAD_MIN, ALERT_MIN_PRIORITY, ALERT_CHAT_ID
 */

const TD = 'https://api.todoist.com/api/v1';
const MODEL = 'claude-sonnet-5';

// Adaptive thinking is the only on-mode on Sonnet 5, and thinking tokens count
// against max_tokens — so this is deliberately generous. Replies are two lines;
// we only ever pay for what is actually generated.
const MAX_TOKENS = 16000;

const TG_LIMIT = 4096; // Telegram rejects sendMessage above this

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

  // Two cron jobs share this handler; event.cron says which one fired.
  //
  //   */5 * * * *          -> dueSoonAlerts: high-priority tasks about to start
  //   30 5 / 30 6 * * *    -> morningDigest: the day's plan
  //
  // Cloudflare schedules in UTC only, so both the summer and winter UTC
  // equivalents of DIGEST_AT are registered and morningDigest() decides which
  // one is actually 07:30 in Madrid today.
  async scheduled(event, env, ctx) {
    const job = event.cron?.startsWith('*/5')
      ? dueSoonAlerts(env).catch(err => console.error('alerts', err.stack))
      : morningDigest(env).catch(err => console.error('digest', err.stack));
    ctx.waitUntil(job);
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
    try {
      text = await transcribe(env, voice.file_id);
    } catch (e) {
      console.error('transcribe', e.stack);
      return void say(env, chatId, `⚠️ Не смог разобрать голосовое: ${e.message}`);
    }
  }
  if (!text) return;

  // In a group, commands arrive as "/rules@botname" — strip the mention.
  const cmd = text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();

  if (cmd === '/start' || cmd === '/help') {
    return void say(env, chatId,
      'Пиши или наговаривай: «купить молоко завтра», «перенеси дантиста на пятницу», «садик — сделано», «что на сегодня?»\n\n' +
      'Напоминания: «напомни завтра в 18:00 забрать посылку» или «это важно» — подниму приоритет и пришлю сюда сигнал за 5 минут.\n\n' +
      '/rules — правила бота, /rules reset — сбросить, /reset — забыть контекст разговора.');
  }
  if (cmd === '/reset') {
    await env.CHATS.delete(`hist:${chatId}`);
    return void say(env, chatId, 'Контекст очищен.');
  }
  if (cmd === '/rules') {
    if (text.includes('reset')) {
      await env.CHATS.delete('rules');
      return void say(env, chatId, 'Правила сброшены на стандартные.');
    }
    const rules = await getRules(env);
    return void say(env, chatId,
      `*Правила бота:*\n${rules.map((r, i) => `${i + 1}. ${r}`).join('\n')}\n\n` +
      '_Скажи или напиши «правило: …» чтобы добавить, «убери правило N» чтобы удалить._');
  }

  // In a group, who spoke matters — Claude needs it to resolve "я сделал".
  const speaker = msg.from?.first_name || 'unknown';
  const isGroup = msg.chat.type !== 'private';
  const userTurn = isGroup ? `[${speaker}]: ${text}` : text;

  await tg(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });
  try {
    const reply = await converse(env, chatId, userTurn);
    await say(env, chatId, (voice ? `🎤 _${text}_\n\n` : '') + reply,
      { reply_to_message_id: isGroup ? msg.message_id : undefined });
  } catch (e) {
    console.error(e.stack);
    await say(env, chatId, `⚠️ ${e.message}`.slice(0, 500));
  }
}

// =============================================================== todoist ====
/**
 * Todoist has visible bad spells — slow responses and intermittent 502s — so
 * 429 and 5xx are retried, matching what claude() already did.
 *
 * The X-Request-Id is generated ONCE per call and reused across attempts. That
 * is what makes retrying a write safe: Todoist deduplicates on it, so a retried
 * add_task cannot create the task twice. (Regenerating it per attempt, as this
 * did before, made the header decorative.)
 */
async function todoist(env, path, { method = 'GET', body } = {}) {
  const reqId = crypto.randomUUID();
  let status = 0;
  let detail = '';

  for (let attempt = 0; attempt < 3; attempt++) {
    let r;
    try {
      r = await fetch(TD + path, {
        method,
        headers: {
          Authorization: `Bearer ${env.TODOIST_API_TOKEN}`,
          'Content-Type': 'application/json',
          ...(method !== 'GET' ? { 'X-Request-Id': reqId } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch (e) {                                   // DNS / TLS / connection reset
      status = 0;
      detail = e.message;
      if (attempt === 2) break;
      await sleep(400 * 2 ** attempt);
      continue;
    }

    if (r.ok) return r.status === 204 ? null : r.json();

    status = r.status;
    detail = (await r.text()).slice(0, 300);
    if (status !== 429 && status < 500) break;      // 4xx is our bug, not theirs
    if (attempt === 2) break;
    const retryAfter = Number(r.headers.get('retry-after')) * 1000;
    await sleep(Math.min(retryAfter || 400 * 2 ** attempt, 5000));
  }

  console.error(`Todoist ${method} ${path} -> ${status} ${detail}`);
  // Keep the raw shape for our own mistakes; give people something human for theirs.
  if (status === 0 || status >= 500) {
    throw new Error('Todoist сейчас не отвечает. Попробуй ещё раз через минуту.');
  }
  throw new Error(`Todoist ${method} ${path} → ${status} ${detail}`);
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
  const lead = Number(env.ALERT_LEAD_MIN || 5);
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
- Not every message is a task. If someone is just chatting, reply briefly and call no tools.

Reminders — raised priority IS the reminder:
- A background job alerts this chat ${lead} minutes before any task whose priority is 2 or higher AND that has a specific time. There is no separate reminder object; priority is the switch.
- Treat as a reminder request: «напомни», «напоминание», «не забудь», «не дай забыть», «поставь будильник», «recuérdame», or the person calling something важно / срочно / important / urgente.
- On such a request set priority — 4 for «срочно», «горит», «urgente»; 3 for «важно», «important»; 2 otherwise — and make sure the task has a TIME, not just a day.
- A task with only a day and no time never alerts. If a reminder was asked for but no time was given, still create or update the task with the raised priority FIRST — never withhold the task while waiting for an answer — and then ask for the time in one short question so the alert can be armed. Do not invent a time yourself.
- If a task already exists and someone asks to be reminded about it, raise its priority with update_task and add a time — do not create a duplicate.
- When you set a reminder, say so and state when the alert will arrive, e.g. «Напомню в 17:55».
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

    if (res.stop_reason === 'refusal') {
      return 'Не могу это выполнить.';
    }

    // Echo the assistant turn back verbatim — thinking blocks included. They
    // must survive the tool round-trip unchanged or the next call 400s.
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
    // All results for one assistant turn go back in a SINGLE user message.
    messages.push({ role: 'user', content: results });
  }
  return 'Слишком много шагов — остановился.';
}

async function claude(env, system, messages) {
  const body = {
    model: env.CLAUDE_MODEL || MODEL,
    max_tokens: MAX_TOKENS,
    // Adaptive thinking is the only on-mode on Sonnet 5; effort controls depth.
    // "low" keeps a "купить молоко" turn fast and cheap.
    thinking: { type: 'adaptive' },
    output_config: { effort: env.CLAUDE_EFFORT || 'low' },
    system,
    tools,
    messages,
  };

  let last = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (r.ok) return r.json();

    last = `Anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`;
    // 429 and 5xx are worth another go; 400/401/404 never are.
    if (r.status !== 429 && r.status < 500) break;
    if (attempt === 2) break;
    const retryAfter = Number(r.headers.get('retry-after')) * 1000;
    await sleep(Math.min(retryAfter || 400 * 2 ** attempt, 5000));
  }
  throw new Error(last);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * Persist text only. Tool blocks are dropped deliberately: they are bulky and
 * they embed task ids that may be stale by the next message. Thinking blocks go
 * too — they are only required within a single tool round-trip, not across turns.
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

/**
 * Send with Markdown, and fall back to plain text if Telegram rejects it.
 * Task titles routinely contain _ * ` and [ ], any of which makes Telegram
 * 400 the whole message — which would otherwise look like the bot went silent.
 */
async function say(env, chatId, text, extra = {}) {
  const body = text.length > TG_LIMIT ? `${text.slice(0, TG_LIMIT - 1)}…` : text;
  const res = await tg(env, 'sendMessage', {
    chat_id: chatId, text: body, parse_mode: 'Markdown', ...extra,
  });
  if (res?.ok) return res;
  console.warn('formatted send failed:', res?.description);
  // Drop parse_mode on the retry — keeping it would fail for the same reason.
  const { parse_mode: _drop, ...rest } = extra;
  return tg(env, 'sendMessage', { chat_id: chatId, text: body, ...rest });
}

async function transcribe(env, fileId) {
  if (!env.GROQ_API_KEY) throw new Error('GROQ_API_KEY not set — voice disabled.');

  const info = await (await fetch(`${tgBase(env)}/getFile?file_id=${fileId}`)).json();
  if (!info?.ok || !info.result?.file_path) {
    throw new Error(`Telegram getFile failed: ${info?.description ?? 'no file_path'}`);
  }
  const audio = await (await fetch(
    `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${info.result.file_path}`,
  )).arrayBuffer();

  const form = new FormData();
  form.append('file', new Blob([audio]), 'voice.ogg');
  form.append('model', 'whisper-large-v3-turbo');
  form.append('response_format', 'json');
  // No `language` field: the family speaks Russian and Spanish, so let Whisper detect.

  const r = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`Groq ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()).text;
}

// ========================================================= morning digest ===
const TD_APP = 'https://app.todoist.com/app';
/** KV key holding the ids the last few morning nudges already suggested. */
const RECENT_KEY = 'suggest:recent';

/** Local wall-clock parts in `tz`, as the family experiences them. */
function localParts(tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date()).map(x => [x.type, x.value]));
  return { date: `${p.year}-${p.month}-${p.day}`, hour: +p.hour, minute: +p.minute };
}

const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** "14 авг" — built from the date string itself, so no timezone shifting. */
function shortDate(isoDate) {
  const d = new Date(`${isoDate.slice(0, 10)}T12:00:00Z`);
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(d);
}

/**
 * Posts today's plan to DIGEST_CHAT_ID at DIGEST_AT local time.
 *
 * Cloudflare cron expressions are UTC-only with no timezone support, so
 * wrangler.toml registers 06:20 and 07:20 UTC — the CEST and CET equivalents of
 * 08:20 Madrid. Whichever one lands inside the window runs; the other returns
 * immediately. A KV day-key makes the send idempotent regardless.
 */
async function morningDigest(env) {
  const tz = env.TZ_NAME || 'Europe/Madrid';
  const chatId = (env.DIGEST_CHAT_ID || (env.ALLOWED_CHAT_IDS || '').split(',')[0] || '').trim();
  if (!chatId) return void console.warn('digest: no DIGEST_CHAT_ID / ALLOWED_CHAT_IDS');

  const [th, tm] = (env.DIGEST_AT || '08:20').split(':').map(Number);
  const now = localParts(tz);
  const drift = (now.hour * 60 + now.minute) - (th * 60 + tm);
  // 30-minute window: cron firings can be delayed, but the other half-year's
  // trigger is a full hour away and must not slip through.
  if (drift < 0 || drift >= 30) {
    return void console.log(`digest: skip, local ${now.hour}:${now.minute} (drift ${drift}m)`);
  }

  const dayKey = `digest:${now.date}`;
  if (await env.CHATS.get(dayKey)) return void console.log('digest: already sent', now.date);
  await env.CHATS.put(dayKey, '1', { expirationTtl: 172800 });

  const [all, people] = await Promise.all([listTasks(env), roster(env)]);
  const nameOf = Object.fromEntries(people.map(p => [p.id, p.name.split(' ')[0]]));

  const due = all
    .filter(t => t.due?.date && t.due.date.slice(0, 10) <= now.date)
    .sort((a, b) => a.due.date.localeCompare(b.due.date));

  const line = t => {
    const who = t.responsible_uid ? nameOf[String(t.responsible_uid)] : null;
    const at = t.due.date.length > 10 ? ` ${t.due.date.slice(11, 16)}` : '';
    const bits = [`• <a href="${TD_APP}/task/${t.id}">${escapeHtml(t.content)}</a>${at}`];
    if (who) bits.push(`· ${escapeHtml(who)}`);
    return bits.join(' ');
  };

  const overdue = due.filter(t => t.due.date.slice(0, 10) < now.date);
  const today = due.filter(t => t.due.date.slice(0, 10) === now.date);

  if (due.length) {
    const out = [`🌅 <b>Задачи на ${shortDate(now.date)}</b>`];
    if (overdue.length) {
      out.push('', `⚠️ <b>Просрочено</b>`);
      out.push(...overdue.map(t => `${line(t)} <i>(${shortDate(t.due.date)})</i>`));
    }
    if (today.length) {
      out.push('', `📅 <b>Сегодня</b>`);
      out.push(...today.map(line));
    }
    out.push('', `<a href="${TD_APP}/project/${env.TODOIST_PROJECT_ID}">Открыть в Todoist</a>`);
    await say(env, chatId, out.join('\n'), { parse_mode: 'HTML', disable_web_page_preview: true });
    console.log(`digest: sent ${overdue.length} overdue + ${today.length} today`);
  } else if (env.DIGEST_SKIP_EMPTY === 'false') {
    await say(env, chatId, `🌅 <b>${shortDate(now.date)}</b> — на сегодня ничего не запланировано.`,
      { parse_mode: 'HTML', disable_web_page_preview: true });
  } else {
    console.log('digest: nothing due');
  }

  // Follow-up nudge. Runs even on a quiet morning — a day with nothing planned
  // is exactly when picking something off the undated pile is worth suggesting.
  await suggestUndated(env, chatId, all, nameOf);
}

/**
 * Fisher-Yates over a copy, drawing from Web Crypto rather than Math.random().
 *
 * A cron firing usually gets a cold isolate, and Math.random() there replayed
 * the same sequence every morning — so the "может, сегодня?" nudge kept naming
 * the same two tasks. crypto.getRandomValues() is properly seeded per call.
 */
function shuffled(items) {
  const out = items.slice();
  const rnd = new Uint32Array(out.length);
  crypto.getRandomValues(rnd);
  for (let i = out.length - 1; i > 0; i--) {
    const j = rnd[i] % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * Second morning message: a couple of tasks that have no due date at all,
 * chosen at random, offered as candidates for today.
 *
 * Random rather than oldest-first on purpose — a fixed order would surface the
 * same stale tasks every morning until someone finally did them, and the family
 * would learn to skim past the message. Recently suggested ids are remembered
 * for a few days on top of that, so chance alone cannot repeat yesterday.
 */
async function suggestUndated(env, chatId, all, nameOf) {
  const n = Number(env.SUGGEST_COUNT || 5);
  if (n < 1) return;

  const pool = all.filter(t => !t.due?.date);
  if (!pool.length) return void console.log('suggest: no undated tasks');

  // Prefer tasks the last few mornings have not already offered; fall back to
  // the whole pile once the cooldown list has eaten most of it.
  const recent = (await env.CHATS.get(RECENT_KEY, 'json')) || [];
  const unseen = pool.filter(t => !recent.includes(String(t.id)));
  const picks = shuffled(unseen.length >= n ? unseen : pool).slice(0, n);

  const lines = picks.map(t => {
    const who = t.responsible_uid ? nameOf[String(t.responsible_uid)] : null;
    return `\u2022 <a href="${TD_APP}/task/${t.id}">${escapeHtml(t.content)}</a>`
      + (who ? ` \u00b7 ${escapeHtml(who)}` : '');
  });

  const rest = pool.length - lines.length;
  const tail = rest > 0 ? `\n\n<i>\u0415\u0449\u0451 ${rest} \u0431\u0435\u0437 \u0441\u0440\u043e\u043a\u0430.</i>` : '';

  await say(env, chatId,
    `\ud83d\udca1 <b>\u0411\u0435\u0437 \u0441\u0440\u043e\u043a\u0430 \u2014 \u043c\u043e\u0436\u0435\u0442, \u0441\u0435\u0433\u043e\u0434\u043d\u044f?</b>\n${lines.join('\n')}${tail}\n\n`
    + `<i>\u0421\u043a\u0430\u0436\u0438 \u00ab${escapeHtml(picks[0].content)} \u2014 \u0441\u0435\u0433\u043e\u0434\u043d\u044f\u00bb, \u0438 \u043f\u043e\u0441\u0442\u0430\u0432\u043b\u044e \u0441\u0440\u043e\u043a.</i>`,
    { parse_mode: 'HTML', disable_web_page_preview: true });

  // Keep a few rounds of history, but never more than the pool can spare.
  const keep = Math.min(n * 3, Math.max(0, pool.length - n));
  const memo = [...picks.map(t => String(t.id)), ...recent].slice(0, keep);
  await env.CHATS.put(RECENT_KEY, JSON.stringify(memo), { expirationTtl: 1209600 });

  console.log(`suggest: sent ${lines.length} of ${pool.length} undated, ${recent.length} on cooldown`);
}

// ======================================================== due-soon alerts ===
/**
 * Offset of `tz` from UTC, in ms, at a given instant. Positive east of Greenwich.
 */
function tzOffsetMs(instant, tz) {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(instant).map(x => [x.type, x.value]));
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second);
  return asUtc - instant.getTime();
}

/**
 * Todoist returns timed due dates as FLOATING local time ("2026-08-19T18:00:00",
 * timezone: null) — wall clock in the user's zone, with no offset. Workers run in
 * UTC, so Date.parse() would read that as 18:00 UTC, two hours early in Madrid.
 * Resolve it against TZ_NAME instead; the second pass catches the DST edge where
 * the first guess lands on the other side of a transition.
 */
function dueInstant(due, tz) {
  const s = due?.date;
  if (!s) return null;
  if (s.length <= 10) return null;                 // date-only: no time to lead
  if (/[Z+]|-\d\d:\d\d$/.test(s.slice(10))) return Date.parse(s);  // already absolute
  const base = Date.parse(`${s}Z`);
  if (Number.isNaN(base)) return null;
  let t = base - tzOffsetMs(new Date(base), tz);
  t = base - tzOffsetMs(new Date(t), tz);
  return t;
}

const PRIORITY_MARK = { 4: '🔴', 3: '🟠', 2: '🔵' };  // API 4/3/2 = UI p1/p2/p3

/**
 * Every 5 minutes: warn the chat about high-priority tasks coming due within
 * ALERT_LEAD_MIN. One message per task per due-time, deduped in KV.
 *
 * Only tasks with an actual time qualify — a date-only task has no moment to
 * count back from, and would otherwise fire at midnight.
 */
async function dueSoonAlerts(env) {
  const tz = env.TZ_NAME || 'Europe/Madrid';
  const chatId = (env.ALERT_CHAT_ID || env.DIGEST_CHAT_ID
    || (env.ALLOWED_CHAT_IDS || '').split(',')[0] || '').trim();
  if (!chatId) return void console.warn('alerts: no chat id');

  const lead = Number(env.ALERT_LEAD_MIN || 5);
  const minPrio = Number(env.ALERT_MIN_PRIORITY || 2);   // API scale: >1 = above default

  const all = await listTasks(env);
  const now = Date.now();

  const soon = [];
  for (const t of all) {
    if ((t.priority ?? 1) < minPrio) continue;
    const at = dueInstant(t.due, tz);
    if (at === null) continue;
    const mins = (at - now) / 60000;
    // Window runs slightly past the lead time and a little before it, to absorb
    // cron jitter. Double firings are harmless — the KV key below dedupes.
    if (mins > lead + 1 || mins < -2) continue;
    soon.push({ t, at });
  }
  if (!soon.length) return;

  const people = await roster(env);
  const nameOf = Object.fromEntries(people.map(p => [p.id, p.name.split(' ')[0]]));
  const hhmm = ms => new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).format(new Date(ms));

  const fresh = [];
  for (const s of soon) {
    // Keyed on the due time too, so rescheduling a task re-arms its alert.
    const key = `alert:${s.t.id}:${s.t.due.date}`;
    if (await env.CHATS.get(key)) continue;
    await env.CHATS.put(key, '1', { expirationTtl: 172800 });
    fresh.push(s);
  }
  if (!fresh.length) return;

  const lines = fresh.map(({ t, at }) => {
    const who = t.responsible_uid ? nameOf[String(t.responsible_uid)] : null;
    const mark = PRIORITY_MARK[t.priority] || '';
    return `${mark} <a href="${TD_APP}/task/${t.id}">${escapeHtml(t.content)}</a>`
      + ` — ${hhmm(at)}${who ? ` · ${escapeHtml(who)}` : ''}`;
  });

  await say(env, chatId, `⏰ <b>Скоро (через ~${lead} мин)</b>\n${lines.join('\n')}`,
    { parse_mode: 'HTML', disable_web_page_preview: true });
  console.log(`alerts: sent ${fresh.length}`);
}
