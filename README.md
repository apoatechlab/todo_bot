# Family task bot — Telegram → Claude → Todoist

A Telegram bot for household tasks. Family members send text or voice messages in
natural language; the bot turns them into operations on **one** Todoist project.

```
Telegram (text or voice)
   → Groq Whisper          (voice only: .oga → text)
   → Claude, with tools    (decides what to do)
   → Todoist API v1        (scoped to one project)
   → reply in Telegram
```

| Message | Result |
|---|---|
| «купить молоко завтра» | task created, due tomorrow |
| «перенеси дантиста на пятницу» | existing task rescheduled |
| «садик — сделано» | task completed |
| «что на сегодня?» | reads back today's tasks |
| «правило: покупки с меткой продукты» | new standing rule saved |

Voice and text are equivalent everywhere. Audio is transcribed *before* Claude
sees it, so any capability added as a tool works in both channels automatically.

---

## 1. Layout

```
src/index.js            the Worker — everything lives here
src/app.html            the Mini App page, bundled in as a string (§9)
wrangler.toml           non-secret config; project id and timezone are filled in
scripts/wg.sh           wrangler wrapper — prefers wrangler.local.toml
scripts/google-auth.mjs one-time Google OAuth for the archive (§11)
scripts/set-webhook.sh  register the Telegram webhook
scripts/webhook-info.sh webhook status (first place to look when it goes quiet)
.dev.vars.example       template for `wrangler dev`
extracted/              the original design handoff, unchanged, for reference
```

Deployment is **Cloudflare Workers**: webhook-driven, serverless, free, no machine
to keep alive. Free tier: 100k requests/day, 10 ms CPU per invocation, 50
subrequests per invocation; KV 100k reads/day, 1k writes/day, 1 GB.

**The 10 ms CPU limit is not a problem** — Cloudflare does not count time spent
waiting on `fetch()` or KV toward CPU time, and this bot is ~95% network wait.
The two limits that could realistically bite are 50 subrequests per invocation
(a busy turn uses 10–20, which is why `listTasks` caps at 3 pages) and 1k KV
writes/day (one write per message — irrelevant for a family).

A zero-dependency long-polling Node variant exists in `extracted/family-todo-bot.mjs`
if this ever needs to run next to an always-on box instead. It is **not**
maintained against `src/index.js` — it still carries the old model id and none of
the fixes in §6.

---

## 2. Committed configuration

`wrangler.toml` is tracked in git and holds **no secrets** — only the
non-sensitive knobs below. The values are those of the original deployment; a
fork should change the project, chat and timezone (see §3.3).

| Var | Value | Note |
|---|---|---|
| `TODOIST_PROJECT_ID` | `REPLACE_ME` | last path segment of the project URL |
| `TZ_NAME` | `Europe/Madrid` | account timezone |
| `TODOIST_DUE_LANG` | `ru` | Todoist's natural-language date parser |
| `CLAUDE_MODEL` | `claude-sonnet-5` | |
| `CLAUDE_EFFORT` | `low` | thinking depth; raise if it starts misreading messages |
| `DIGEST_AT` | `07:30` | morning digest, local time — see §7 |
| `ALLOWED_CHAT_IDS` | `REPLACE_ME` | comma-separated Telegram chat ids |
| `ALLOW_DELETE` | `false` | deletes are mapped to complete |
| `BOT_USERNAME` | `REPLACE_ME` | for the Mini App link — see §9 |
| `MINIAPP_SHORT_NAME` | `REPLACE_ME` | BotFather app short name — see §9 |
| `DRIVE_ROOT_NAME` | `Документы семьи` | Drive folder the archive lives in — see §11 |

Project members are read from Todoist at runtime and cached for a day — nothing
to configure.

Not in git, and never should be: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`,
`ANTHROPIC_API_KEY`, `TODOIST_API_TOKEN`, `GROQ_API_KEY`, `GOOGLE_CLIENT_ID`,
`GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`. They are Cloudflare
Worker secrets. `.dev.vars` (local dev only) is gitignored; `.dev.vars.example`
is the empty template. Personal ids live in the gitignored
`wrangler.local.toml` — see §3.3.

---

## 3. Setup from scratch

**No secret is committed to this repository.** All five live as Cloudflare Worker
secrets (`wrangler secret put`), which are write-only — they can be replaced but
never read back, including by this repo's owner. `wrangler.toml` holds only
non-secret configuration, which is why it is safe to track.

### 3.1 Prerequisites

- Node 20+ and a Cloudflare account (the free plan is enough for everything here)
- A Telegram bot, a Todoist account, an Anthropic API key
- Optionally a Groq key — voice transcription only; text works without it

### 3.2 Get the credentials

| What | Where |
|---|---|
| **Telegram bot token** | `/newbot` in [@BotFather](https://t.me/BotFather) |
| **Todoist API token** | Todoist → Settings → Integrations → Developer |
| **Todoist project id** | last path segment of the project URL |
| **Anthropic API key** | console.anthropic.com |
| **Groq key** (optional) | console.groq.com — Whisper large-v3-turbo, $0.04/hour, free tier ~2,000 req/day, handles Russian and Spanish |

In @BotFather, also run `/setprivacy` → your bot → **Disable**. Without this the
bot only sees messages that start with `/` or @mention it, and typing «купить
молоко завтра» normally in a group will never reach it. **If the bot is already
in the group, remove and re-add it** — the setting only applies on join.

### 3.3 Configure

```bash
npm install
npx wrangler login
npx wrangler kv namespace create CHATS     # paste the id into wrangler.toml
```

The tracked `wrangler.toml` ships `REPLACE_ME` placeholders so this repository
can stay public without publishing anybody's project, chat or namespace ids. Put
your real values in **`wrangler.local.toml`**, which is gitignored:

```bash
cp wrangler.toml wrangler.local.toml   # then fill in the four REPLACE_ME values
```

Drive wrangler through `./scripts/wg.sh` (or the `npm run` scripts, which wrap
it). It uses `wrangler.local.toml` when that file exists and falls back to the
tracked `wrangler.toml` otherwise, so a fresh clone still works:

```bash
npm run deploy          # ./scripts/wg.sh deploy
npm run tail
npm run secret -- put ANTHROPIC_API_KEY
```

Calling `npx wrangler` directly bypasses this and will read the placeholders.

The four values to fill in: the **KV namespace id** from the command above,
`TODOIST_PROJECT_ID` (last path segment of the project URL), and
`ALLOWED_CHAT_IDS` / `DIGEST_CHAT_ID`, which you only learn at step 3.5.

`TZ_NAME` and `TODOIST_DUE_LANG` drive date parsing and every schedule; set them
to your own timezone and language.

### 3.4 Secrets and first deploy

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put TODOIST_API_TOKEN
npx wrangler secret put GROQ_API_KEY
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET   # openssl rand -hex 32 — invent it, keep it
npx wrangler deploy
```

`wrangler secret put` reads the value from **stdin**, and passing it as an
argument fails. In a non-interactive shell it silently stores whatever stdin
gave it — an empty string if there was nothing — and still prints success. Either
run it interactively, or pipe: `echo 'value' | npx wrangler secret put NAME`.

The first `deploy` fails if the account has no `workers.dev` subdomain yet;
answer **yes** to wrangler's prompt to register one. That prompt only appears in
an interactive terminal.

### 3.5 Wire up Telegram

Add the bot to the group, send any message, then read the chat id:

```bash
curl "https://api.telegram.org/bot<TOKEN>/getUpdates"   # message.chat.id — negative for groups
```

Put it in `ALLOWED_CHAT_IDS` and `DIGEST_CHAT_ID`, `npx wrangler deploy` again,
and register the webhook with the **same** secret you set above:

```bash
export TELEGRAM_BOT_TOKEN=... TELEGRAM_WEBHOOK_SECRET=...
./scripts/set-webhook.sh https://family-todo-bot.<sub>.workers.dev
```

An empty `ALLOWED_CHAT_IDS` means **nothing** is allowed through — the bot will
deploy fine and ignore every message. That is deliberate; don't read the silence
as a bug.

### 3.6 Verify

```bash
./scripts/webhook-info.sh          # url set, and no last_error_message
npx wrangler tail                  # live logs while you send a test message
```

A forged request should be refused — this is the check that keeps the Worker URL
from being a public write endpoint:

```bash
curl -s -o /dev/null -w '%{http_code}\n' -X POST https://<your-worker-url> -d '{}'   # expect 403
```

Then in the group: «купить молоко завтра», «что на сегодня?», `/rules`.

---

## 4. Context management

Claude has no memory between messages. Every message rebuilds the whole picture
from scratch. The design question is what goes in, and how long each piece lives.

| Layer | Source | Lifetime | Why |
|---|---|---|---|
| Fixed behaviour | code | never changes | tool-calling rules, language, date passthrough |
| House rules | KV `rules` | until edited | family preferences, editable from Telegram |
| Member roster | KV, 24 h TTL | 24 hours | collaborators never change |
| Task list, filtered | Todoist | **every message** | staleness here is dangerous |
| Rolling conversation | KV `hist:<chat>`, 30 min | 30 minutes | resolves "перенеси её на пятницу" |

**Why the task list is never cached.** A cached list means stale task ids. A task
completed from someone's phone would still be in the prompt, and Claude would
close an id that no longer exists — or the wrong one. The fetch is ~150 ms of
network wait, which costs nothing on Workers.

**Why the list is filtered, not dumped.** `relevantTasks()` sorts overdue →
next 21 days → undated, drops anything dated further out, caps at 70. A family
project accumulates recurring chores and someday-maybes; feeding Claude 300 tasks
is both expensive and *worse*, because «перенеси уборку» then has nine
candidates. Hidden tasks stay reachable via the `search_tasks` tool, and the
prompt states the hidden count so Claude searches instead of denying they exist.

**Why history stores text only.** Tool_use / tool_result blocks are dropped when
persisting: they're bulky, and they embed task ids that may be stale next turn.
Thinking blocks are dropped for the same reason — they only need to survive
*within* one tool round-trip, which they do (see §6).

**Why the TTL is short.** An errand two hours later shouldn't inherit the
referents of the previous one.

**Group chats.** Messages are prefixed `[Name]: ` before Claude sees them.
Without this, «я сделал садик» is unresolvable and assignment is impossible.

Roughly 1.5–2k input tokens per turn with 50 tasks visible.

**Prompt caching is deliberately not used.** The cheap thing to cache would be
the tool list plus the fixed behaviour block, but that prefix sits just around
the ~1024-token minimum, the cache TTL is 5 minutes, and family messages arrive
minutes-to-hours apart — so nearly every write would expire before it was read,
at 1.25× the input price. Revisit only if usage becomes bursty.

---

## 5. Two tiers of rules

### Fixed — in code, Claude cannot change it

- `project_id` is injected server-side on every `add_task`.
- Every update / complete / delete re-fetches the task and **refuses** if it
  belongs to another project (`assertInProject`).
- This is why "always add to project X" is not phrased as a prompt instruction.
  A rule would be a suggestion; this is a wall. A house rule saying "ignore the
  project restriction" does nothing.

### House rules — in KV, editable from Telegram by text or voice

Seeded defaults:

1. Не ставь срок, если он не назван явно — задача без даты лучше выдуманной.
2. «Вечером», «на выходных», «завтра» — это явные сроки, передавай как есть.
3. Приоритет по умолчанию обычный. p4 только если «срочно» или «горит».
4. Формулируй коротко и с глаголом: «купить молоко», не «молоко надо купить».
5. Перед созданием проверь список: если похожая задача есть — обнови срок.
6. Если названо имя члена семьи — назначь на него.
7. Голосовые содержат оговорки и «эээ» — вытаскивай смысл, не мусор.

Rule 1 is the "no invented deadlines" requirement. Rule 2 exists because rule 1
alone makes Claude too timid — it starts treating «завтра» as not explicit enough.

Editing, by voice or text:

- «Правило: покупки всегда с меткой продукты» → `add_house_rule`
- «Убери правило 3» → `remove_house_rule`
- `/rules` — print numbered list
- `/rules reset` — restore defaults
- `/reset` — clear conversation memory only
- `/digest` — post the morning digest into this chat right now (§7)
- `/school` — list the shaded calendar days; `/school reset` clears them (§10)
- `/docs` — what is in the document archive (§11)

Cap: 25 rules. House rules are persuasion, not enforcement — if the bot starts
behaving oddly, `/rules` is the first place to look.

Note that `rules` is a single global KV key, not per-chat. With one family group
that is what you want; if a second chat is ever added to `ALLOWED_CHAT_IDS` it
will share the same rule list.

### Tools exposed to Claude

`add_task`, `update_task` (also used for postponing), `complete_task`,
`delete_task`, `search_tasks`, `add_house_rule`, `remove_house_rule`.
Agent loop caps at 5 hops.

---

## 6. Anthropic API — what changed from the handoff draft

The draft was written against an older API. Current state:

- **Model is `claude-sonnet-5`**, overridable per-environment via `CLAUDE_MODEL`.
- **Adaptive thinking** (`thinking: {type: "adaptive"}`) — the only on-mode on
  this model. The old fixed `budget_tokens` form is rejected with a 400, as are
  `temperature` / `top_p` / `top_k`.
- **`output_config.effort`** replaces the thinking budget as the depth control.
  `low` keeps a «купить молоко» turn fast; raise it if the bot starts fumbling
  multi-instruction messages or messy transcripts.
- **`max_tokens` raised to 16000.** Thinking tokens count against `max_tokens`,
  so the draft's 1500 would truncate a turn mid-tool-call. You are only billed
  for what is actually generated, so a high ceiling is free.
- **Thinking blocks are echoed back verbatim** inside the tool loop. The loop
  already pushed `res.content` unchanged, which is exactly what's required —
  stripping them there would 400 the following request.
- **`stop_reason: "refusal"`** is handled rather than falling through into an
  empty reply.
- **429 and 5xx are retried** up to twice with backoff, honouring `retry-after`.
  4xx is not retried.

Other fixes over the draft:

- **Markdown send failure.** Task titles routinely contain `_ * \` [ ]`, any of
  which makes Telegram reject the whole message with a 400 — the bot would
  appear to go silent. `say()` retries once as plain text.
- **Messages over 4096 chars** are clipped instead of being rejected outright.
- **Group commands.** `/rules@botname` is what Telegram actually delivers in a
  group; commands are now matched on the stripped first token.
- **`transcribe()` guards `getFile`** instead of destructuring `undefined`, and
  a transcription failure now reports itself in the chat rather than dying
  silently in `waitUntil`.
- **`nodejs_compat` dropped** — `fetch`, `FormData`, `Blob` and
  `crypto.randomUUID` are all native to workerd.
- **Added a "not every message is a task" line** to the system prompt. With
  `/setprivacy` off the bot sees *every* message in the group, including ordinary
  chatter, and each one costs an API call.

---

## 7. Morning digest

At **07:30 Europe/Madrid** the Worker posts the day's plan to `DIGEST_CHAT_ID`:
overdue tasks first, then today's, each a deep link into Todoist, with the
assignee's first name and a time where one is set, and an "Открыть в Todoist"
project link at the bottom.

```
🌅 Задачи на 19 авг.

⚠️ Просрочено
• оплатить счёт за свет · Kseniia (18 авг.)

📅 Сегодня
• купить молоко · Anton
• садик 18:00

Открыть в Todoist
```

| Var | Default | Meaning |
|---|---|---|
| `DIGEST_CHAT_ID` | `REPLACE_ME` | where to post; falls back to the first allowlisted chat |
| `DIGEST_AT` | `07:30` | local time in `TZ_NAME` |
| `DIGEST_SKIP_EMPTY` | `true` | `false` posts "ничего не запланировано" instead of staying quiet |
| `SUGGEST_COUNT` | `5` | undated tasks offered in the follow-up; `0` disables it |

**Why two cron triggers.** Cloudflare cron expressions are UTC-only with no
timezone support, so `wrangler.toml` registers **both** `30 5 * * *` and
`30 6 * * *` — 07:30 Madrid in CEST and in CET respectively. `morningDigest()`
compares the current local wall clock against `DIGEST_AT` and returns
immediately unless it is within a 30-minute window after it, so the off-season
firing is a no-op. The window is 30 minutes because cron firings can be delayed,
while the other half-year's trigger is a full hour away and must not slip
through. A KV key `digest:<YYYY-MM-DD>` makes the send idempotent regardless, so
even a double firing posts once.

This also means **the digest self-corrects across DST** — nothing to change in
March or October.

### Running it by hand

`/digest` takes the same path as the 07:30 cron and posts into the chat it was
called from. Both cron guards — the 30-minute window and the KV day key — exist
only to stop the schedule firing twice, so a hand-run skips them, and skips
*writing* the day key too: otherwise testing at 07:00 would swallow the real
digest half an hour later. A hand-run also ignores `DIGEST_SKIP_EMPTY`, since a
command that answers with silence looks broken.

### Second message: undated nudge

Straight after the digest the Worker sends a follow-up offering
`SUGGEST_COUNT` (default 5) tasks that have **no due date at all**, picked at
random, as candidates for today:

```
💡 Без срока — может, сегодня?
• починить кран
• сходить в санте джелато
• заточка ножей
• найти гладильную доску
• купить булгур

Ещё 2 без срока.

Скажи «починить кран — сегодня», и поставлю срок.
```

**Random, not oldest-first.** A fixed order would surface the same stale tasks
every morning until somebody finally did them, and the family would learn to
skim past the message.

**Randomness comes from `crypto.getRandomValues()`, not `Math.random()`.** A
cron firing usually lands on a cold isolate, where `Math.random()` replayed the
same sequence every morning — so the nudge kept naming the same two tasks. On
top of that, the ids of the last few rounds are kept in KV under
`suggest:recent` and skipped while the pool still has enough alternatives, so
chance alone cannot hand back yesterday's pair.

**It sends even on a quiet morning.** A day with nothing scheduled is exactly
when picking something off the undated pile is worth suggesting, so this
follow-up runs regardless of whether the digest itself had anything to report —
including when `DIGEST_SKIP_EMPTY` suppressed the digest entirely. If there are
no undated tasks, it stays silent. `SUGGEST_COUNT = "0"` turns it off.

**Formatting is HTML, not Markdown.** Task titles routinely contain `_ * [ ]`,
which would break Markdown links; HTML needs only `& < >` escaped, which is
deterministic. `say()` still falls back to plain text if Telegram rejects it.

**Deep links are constructed, not returned.** Todoist API v1 task objects have
no `url` field (REST v2 did), so links are built as
`https://app.todoist.com/app/task/<id>`.

---

## 8. Due-soon alerts

Every 5 minutes the Worker warns the chat about **high-priority tasks starting
within `ALERT_LEAD_MIN`**:

```
⏰ Скоро (через ~5 мин)
🟠 забрать посылку — 18:09 · Anton
🔴 лекарство — 18:07
```

| Var | Default | Meaning |
|---|---|---|
| `ALERT_LEAD_MIN` | `5` | how many minutes ahead to warn |
| `ALERT_MIN_PRIORITY` | `2` | API scale — see the inversion note below |
| `ALERT_CHAT_ID` | — | falls back to `DIGEST_CHAT_ID` |

### Asking for a reminder

There is no separate reminder object — **raised priority _is_ the reminder**,
and the system prompt tells Claude so. Saying «напомни», «напоминание», «не
забудь», «поставь будильник», «recuérdame», or calling something важно / срочно
/ urgente makes it set the priority:

| Said | Priority set | UI |
|---|---|---|
| «срочно», «горит», «urgente» | 4 | 🔴 p1 |
| «важно», «important» | 3 | 🟠 p2 |
| «напомни», «не забудь» | 2 | 🔵 p3 |

Because the alert also needs a *time*, Claude creates or updates the task with
the raised priority **first**, then asks for the time in one short question —
never withholding the task while it waits for an answer. That ordering was a
deliberate fix: on the first pass it asked for the time and created nothing, so
an unanswered question silently lost the task.

Asking about a task that already exists raises *its* priority via `update_task`
rather than creating a duplicate. Verified against the live API: «напомни про
садик в 17:00» with «садик» already in the list produced
`update_task(task_id: T9, priority: 2, due_string: "17:00")`, while a plain
«купить хлеб завтра» sets no priority at all.

**Todoist inverts priority.** API `priority: 1` is the *default* (shown as p4,
no flag, in the UI). So "above default" is API 2, 3, 4 — the UI's p3, p2, p1.
The marks in the message follow the UI: 🔵 p3, 🟠 p2, 🔴 p1.

**Only tasks with a time qualify.** A date-only task has no moment to count back
from; including them would fire every one of them at midnight. Set a time on
anything you want a nudge for.

**Floating local time is the trap here.** Todoist returns timed due dates as
`2026-08-19T18:00:00` with `timezone: null` — wall clock in the user's zone, no
offset. Workers run in UTC, so `Date.parse()` reads that as 18:00 **UTC**, which
is 20:00 in Madrid: every alert would fire two hours late in summer, one in
winter. `dueInstant()` resolves the string against `TZ_NAME` instead, with a
second pass to catch the DST-boundary edge case. Verified under `TZ=UTC`: naive
parsing gives `18:00Z`, `dueInstant()` gives the correct `16:00Z`.

**One alert per task per due-time.** The KV key is
`alert:<taskId>:<dueString>`, so a task alerts once — but rescheduling it
changes the key and re-arms the alert. There is no re-nagging: if nobody acts,
the group is not reminded again.

The alert window is slightly wider than the lead time (`-2` to `lead + 1`
minutes) to absorb cron jitter; the KV key makes any double firing harmless.
This job costs **no Claude tokens** — it is a plain Todoist read plus a send.

---

## 9. Mini App — календарь

The morning digest carries a **📅 Календарь** button that opens a Telegram Mini
App: the project's tasks on a month grid or a week list.

```
┌──────────────────────────────┐
│  [  Месяц  ]    Неделя       │
│  ‹   Сентябрь 2026   ›  Сегодня │
│  Пн Вт Ср Чт Пт Сб Вс        │
│      1  2  3  4  5  6        │   ← dots under each day, one per task,
│   7  8  9 10 11 12 13        │     coloured by priority
│  …                           │
│  2 сентября        3 задачи  │
│  │ Обработка от насекомых    │
│  │ 09:30 · Антон             │
│  │ занятие Майи  11:00 · Аня │
│  │ полить растения  ↻        │
│                              │
│  ⚠️ Просрочено · 2           │
│  ▸ Без срока · 11            │
└──────────────────────────────┘
```

Month view opens on today and shows the selected day's tasks underneath; week
view lists all seven days inline. Both are followed by an overdue block and a
collapsed "без срока" list. Tapping a task opens it in Todoist.

### Why a direct link and not a `web_app` button

Bot API allows inline `web_app` buttons **only in private chats**, and the
digest goes to the family group. So the button is an ordinary `url` button
pointing at `https://t.me/<bot>/<app>` — a Direct Link Mini App, which opens
the same page from a group just as well.

The cost is one-time BotFather setup (§9.2). If `BOT_USERNAME` or
`MINIAPP_SHORT_NAME` is missing or still `REPLACE_ME`, the button is simply left
off the digest — a placeholder button would look real and 404 on tap.

The button rides on the digest. On a morning where the digest stayed silent
(`DIGEST_SKIP_EMPTY`), the undated nudge carries it instead, so there is exactly
one button per morning and never zero.

### 9.1 Routes and authorisation

| Route | |
|---|---|
| `GET /app` | the page; `no-cache` so a deploy is visible without clearing the Telegram cache |
| `GET /api/tasks` | every task in the project, normalised for the calendar |

Anything else still goes to the Telegram webhook, unchanged.

The page URL is public, so `/api/tasks` trusts nothing until **two** checks pass:

1. **`initData` signature.** Telegram signs the launch parameters with
   HMAC-SHA256 keyed by a digest of the bot token; the client sends the raw
   string back as `Authorization: tma <initData>`. Launches older than 24 h are
   rejected so a copied link stops working.
   Telegram has shipped both "include `signature` in the check string" and
   "exclude it" variants, so both are tried rather than guessed at.
2. **Membership of the family chat.** A valid signature only proves the launch
   came from Telegram — any stranger who finds the link gets one too. The real
   ACL is `getChatMember` against `DIGEST_CHAT_ID`, cached in KV for an hour on
   success and two minutes on failure, so someone just added to the chat is not
   locked out for an hour and a Bot API hiccup is not sticky.

### 9.2 BotFather setup

Once, per bot:

1. `/newapp` → pick the bot → title, description, a 640×360 photo.
2. **Web App URL**: `https://<your-worker-host>/app`.
3. **Short name**: e.g. `calendar` — this is the last segment of the link.

Then fill in `wrangler.local.toml`:

| var | example | |
|---|---|---|
| `BOT_USERNAME` | `my_family_bot` | without the `@` |
| `MINIAPP_SHORT_NAME` | `calendar` | the short name from step 3 |

and redeploy. Opening `https://t.me/<bot>/<app>` should show the calendar.

### 9.3 Notes

**The page is bundled, not fetched.** `src/app.html` is imported as a string via
a wrangler `Text` rule, so there is no second origin, no asset bucket and no
extra request on open.

**Dates never leave string form.** Todoist returns timed dues as floating local
time; the calendar only ever displays them, so all arithmetic goes through UTC
noon (`parse`/`addDays`) and no timezone or DST shift can move a task onto the
neighbouring day.

**Theming is Telegram's, in two layers.** Telegram sets `--tg-theme-*` on
`:root` as inline style and rewrites them the instant the client theme changes,
so the palette follows along with no re-render — `themeChanged` only mirrors
`tg.colorScheme` onto `data-scheme` and repaints the native header.

The second layer matters because clients differ in *which* params they send: an
older one may give `bg_color` and no `secondary_bg_color`, and a light-only
fallback would then paint white cards onto a dark background. So every fallback
is defined twice, and `data-scheme` (inside Telegram) or `prefers-color-scheme`
(in a plain browser) picks the set. `color-scheme` is set alongside it so
scrollbars and the overscroll area follow too, and `html` carries the background
so overscroll does not flash white.

---

## 10. Calendar marks — дни без школы

Whole days can be shaded on the calendar. Today there is one kind, `school-off`,
painted amber: the days Maya's school is shut when it normally would not be.

```
Пн Вт Ср Чт Пт Сб Вс
    1  2 [3] 4  5  6      [3] = today, selected
▓7 ▓8  9 10 11 12 13      ▓   = school closed
14 15 16 17 18 19 20
```

### Why not Todoist tasks

They are not tasks. They cannot be completed, have no assignee or priority, and
arrive in blocks — Christmas is one fortnight, which would be fourteen Todoist
rows. Worse, every one of them would show up in the morning digest as something
to do, the undated nudge could offer them, and an accidental «сделано» would
erase the fact. Keeping them out of the project means none of the existing
paths — digest, nudge, due-soon alerts — need to learn about them at all.

### Storage

One KV key, `marks`, holding ranges:

```json
[
  { "kind": "school-off", "from": "2026-12-22", "to": "2027-01-07", "note": "каникулы" },
  { "kind": "school-off", "from": "2026-10-12", "note": "Fiesta Nacional" }
]
```

`to` is omitted for a single day. A whole school year is ~20 rows and one KV
read. **Colour is not stored** — it lives in `MARK_KINDS` in code, so restyling
the calendar never means rewriting stored data. Adding a kind (отпуск, дежурство)
is one line there plus nothing else: the kind list ships to the page inside
`/api/tasks`, and the renderer reads its label and colours from the response.

Writes prune anything that ended over two months ago — ranges are absolute
dates, so otherwise the list grows by a school year every year.

### Management

Same shape as house rules: say it, or list it.

- **In words.** «В школе у Майи каникулы с 22 декабря по 7 января» → one range.
  Schools publish the year in one go, so `add_day_marks` takes an **array** and
  the whole calendar can be pasted in a single message.
- **`/school`** prints the numbered list; `/school reset` clears it.
- «Убери отметку 3» → `remove_day_mark`.

This is the one place Claude computes a date itself. Everywhere else dates go to
Todoist verbatim as `due_string` and Todoist parses them; marks have no parser
behind them, so the tool description tells the model to resolve the year — and
to remember a school year crosses New Year. Ranges are validated on the way in:
ISO form, `to` not before `from`, and nothing longer than 120 days, which is the
tell for «с 22 декабря по 7 января» resolved into the same year.

### Rendering

- **Month grid:** tinted cell background plus a 1px inset ring. Not a dot — dots
  mean tasks, and giving them a second meaning would make the legend mandatory.
  Selection still overrides the tint: which day you are looking at matters more
  than what kind of day it is.
- **Week view and the selected day:** a chip next to the date, `● педсовет`.
  Chip text is `--text`, not the mark colour — that amber fails contrast on a
  light card.
- **A legend** under the grid, listing only kinds actually present.
- **Weekends are deliberately not painted.** Saturday and Sunday are always off,
  so shading them adds no information and would turn half the grid amber. Amber
  means "a school day that unexpectedly is not one".

Each shaded element carries both hexes inline (`--mark-rgb`, `--mark-rgb-d`) and
CSS picks between them, because an amber that reads as warm cream on white goes
olive at the alpha a near-black card needs. Doing the choice in CSS rather than
in the renderer is what keeps it correct across a live theme switch.

---

## 11. Document archive — Google Drive

Throw a scan or a photo at the bot. It works out what the document is, files it
in Drive under `<категория>/<человек>/`, and remembers enough to find it later:

```
Кинуть в чат:  [фото справки]  «это анализы Ксении»

  📄 общий анализ крови
  анализы / Ксения · 2026-08-12
  [ 📂 Открыть в Drive ]

Спросить:      «найди последние анализы крови Ксении»
               → название, дата и ссылка
```

Files land in `Документы семьи/анализы/Ксения/2026-08-12 — общий анализ крови.pdf`.
The date is the one printed **on** the document — issued, drawn, valid from —
not the day it was uploaded; upload date is only the fallback.

### 11.1 One-time Google setup

```
npm run google:auth
```

The script walks through creating the OAuth client, opens the consent screen,
catches the redirect and prints the three secrets to feed to
`npm run secret put`.

**Run it from a real terminal.** It asks for the client id and secret on stdin,
so a wrapper that does not attach a TTY leaves it waiting forever — Node reports
that as `Detected unsettled top-level await`, which explains nothing. The script
now says so plainly instead, and takes the same values without a prompt:

```
GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... npm run google:auth
npm run google:auth -- --id=... --secret=...
```

The browser half works either way; there is a five-minute window to grant
consent before it gives up.

Creating the OAuth client, in the console as it stands in 2026 — what used to
be *APIs & Services → OAuth consent screen* is now **Google Auth Platform**, and
it opens on a "not configured yet / Get started" wizard:

| | |
|---|---|
| [Create a project](https://console.cloud.google.com/projectcreate) | |
| [Enable the Drive API](https://console.cloud.google.com/apis/library/drive.googleapis.com) | |
| [Auth Platform → Get started](https://console.cloud.google.com/auth/overview) | app name, support email, contact email, accept the policy |
| [Audience](https://console.cloud.google.com/auth/audience) | **Internal** on Workspace; otherwise External, then *Publish app* |
| [Clients → Create client](https://console.cloud.google.com/auth/clients) | **Application type: Desktop app** → gives the id and secret |

Two things worth repeating:

- **The refresh token must not expire.** Google gives one a **7-day** life on an
  app that is *External* **and** in *Testing*, after which the archive quietly
  stops working. Two ways out, and which one you get is decided by the account
  that authorises:
  - **Google Workspace** (mail on your own domain) — set Audience to
    **Internal**. Nothing to publish, no Branding to fill in, no expiry. Only
    accounts in that Workspace can authorise, which is fine: exactly one
    account ever does. Sharing the Drive folder with relatives on gmail.com is
    unaffected — that is a Drive permission, not an OAuth one.
  - **Plain Gmail** — External, then *Publish app*. That button refuses while
    the **Branding** page is incomplete: it wants an application home page and
    a privacy policy URL on a domain verified in Search Console. Verification
    review is still *not* required — `drive.file` is a non-sensitive scope, so
    there is no queue and no "unverified app" wall — but those two links are.
- The scope is **`drive.file`** — access to files this app itself created, and
  nothing else in the Drive. That is why the bot makes its own root folder
  (`DRIVE_ROOT_NAME`) rather than being pointed at an existing one. Share that
  folder from the Drive UI to let the rest of the family in.

Until the secrets are set, sending a file gets a plain "not connected yet"
reply; nothing else in the bot is affected.

### 11.2 What happens to a file

| Step | |
|---|---|
| Intake | `msg.document`, or the largest rendition of `msg.photo`. Telegram re-encodes photos to JPEG, so they carry no `mime_type` of their own |
| Guards | PDF/JPEG/PNG/WebP/GIF only, and ≤ 20 MB — the hard ceiling on what Telegram lets a bot download. HEIC gets told to resend as a photo rather than a file |
| Classify | One dedicated Claude call: the bytes as a `document` or `image` block, a forced `file_document` tool call for the schema |
| File | Find-or-create the folders, resumable upload, keep the `webViewLink` |
| Index | `doc:<driveId>` in KV |

The classification call is deliberately **not** the conversational one. A 20 MB
attachment has no business entering the chat history, and the answer has to be a
filled-in schema rather than prose. Thinking is off on that call because forced
tool choice and extended thinking cannot be combined — and with the schema
forced there is nothing left to reason about.

Uploads are resumable (two requests: session, then bytes). Multipart would be
one request but caps at 5 MB, and Telegram hands over up to 20.

### 11.3 Categories are a list; people are not

**Categories are controlled.** Asked freely each time, a model files «анализы»
today and «медицина» in March, and the archive stops being searchable. The list
lives in KV (falling back to the defaults in `DEFAULT_DOC_CATEGORIES`), the
model must pick from it, and anything it invents anyway is rewritten to
`прочее` on the way in — a document filed under a category no search will ever
name is worse than one filed under «прочее».

**People are free text**, because a family gains names no roster has. Drift is
handled the other way round: the names already in the archive are shown to the
model so it reuses «Ксения» instead of coining «ксюша».

### 11.4 The index

One KV key per document, `doc:<driveId>`, with the searchable fields in the
**key metadata** — KV returns metadata directly from `list()`, so a search walks
the index without reading a single value, and only the handful of records
actually returned are fetched in full. Metadata caps at 1 KB per key, hence the
one-letter field names and the clipped title.

A single JSON blob would have been simpler and wrong: two files arriving at once
would each write back a copy of the list they read, and one would vanish.

Search matches **every** word of the query — «анализ крови» must not return
every анализ in the archive because one word happened to land — and sorts newest
first, since "последние анализы" is the question people actually ask.

### 11.5 Correcting a mistake

Misclassification is a matter of when, not if, so it is fixable by saying so:
«это не анализы, а страховка», «это Ксении, не Майи». That is `refile_document`
— it renames and moves the file in Drive and re-indexes it, so the link keeps
working.

`/docs` prints the archive: how many documents, in which categories.

### 11.6 Who sees what

These are TIE cards, empadronamiento and medical results. Worth being explicit:
Drive links are **not** public — they resolve only for people the folder is
shared with. Claude sees each document once, to classify it. Telegram keeps its
own copy of anything sent to a chat, as it already did. The Worker holds no
copy at all: bytes go straight from Telegram to Drive and are never persisted
in KV.

---

## 12. Safety decisions

- **Chat allowlist** (`ALLOWED_CHAT_IDS`) — the main barrier between the task
  list and the open internet.
- **Webhook secret** — Telegram echoes `X-Telegram-Bot-Api-Secret-Token`;
  anything else gets a 403. Without this, the Worker URL is world-callable.
- **Return 200 before doing the work** (`ctx.waitUntil`). Telegram retries any
  webhook that doesn't answer quickly, and a retry on a slow turn creates the
  task twice.
- **`ALLOW_DELETE=false` by default** — deletes are mapped to complete. Todoist
  deletions aren't recoverable, and a misheard voice note shouldn't wipe a task.
  Flip to `true` once transcription quality is trusted.
- **Project scoping is enforced in code, not prompt** — a prompt injection in a
  task title can't reach other projects.

---

## 13. Gotchas

- **Todoist REST v2 was shut down in February 2026.** Anything on Stack Overflow
  using `/rest/v2/` is dead. Use `/api/v1/`.
- **Dates are never computed.** `due_string` passes the user's own words through;
  Todoist's parser handles ru / es / en via `due_lang`. This is where these bots
  usually go wrong.
- **Shared project attribution.** The token owner is the actor for every write,
  so all changes appear in the Todoist activity log as one person regardless of
  who sent the message. `responsible_uid` is what distinguishes them.
- **Todoist has bad spells.** Intermittent 502s and multi-second responses on
  `/api/v1/tasks` have been observed in the wild (6–8 s where the norm is
  ~150 ms). `todoist()` therefore retries 429 and 5xx twice with backoff,
  honouring `retry-after`, and reports "Todoist сейчас не отвечает" rather than
  a raw status line. 4xx is never retried — that would be our bug, not theirs.
- **`X-Request-Id` is generated once per call and reused across retries.** That
  is what makes retrying a *write* safe: Todoist deduplicates on it, so a
  retried `add_task` cannot create the task twice. An earlier version minted a
  fresh id per attempt, which made the header decorative; if you refactor the
  retry loop, keep the id outside it.
- **Todoist Free** — this account has no Todoist-side reminders, so anything
  push-shaped (a morning digest, a nudge on an overdue task) has to come from a
  Cron Trigger in this Worker, not from Todoist.
- **KV is eventually consistent** — a write can take up to ~60 s to propagate
  between colos. Fine for one family hitting one edge location. If the bot ever
  forgets the immediately preceding message, that's the cause; the fix is a
  Durable Object keyed on chat id (SQLite-backed DOs are on the free plan).
- **Todoist ids prefixed `tmp-`** are unsynced placeholders and will fail
  validation. Not reachable through this code path, but worth knowing.

---

## 14. Possible next steps

- Inline keyboard buttons for confirm-before-delete instead of the on/off flag.
- Re-nagging for missed high-priority alerts (deliberately absent today, see §8).
- Sections support (e.g. groceries into a dedicated section). The project has no
  sections today.
- Completing a task straight from the Mini App calendar (it is read-only
  today; that needs a signed POST and an optimistic redraw).
- Durable Object for conversation state if KV consistency ever bites.
