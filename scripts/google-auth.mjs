#!/usr/bin/env node
/**
 * One-time Google OAuth, so the Worker gets a refresh token it can use forever.
 *
 * Google killed the copy-a-code-from-the-browser flow in 2022, so a redirect
 * back to localhost is the only option left for a desktop client. This serves
 * exactly one request on 127.0.0.1, takes the code, trades it for tokens and
 * prints them. Nothing is written to disk — you paste the results into
 * `wrangler secret put`, which is the only place they belong.
 *
 *   npm run google:auth
 */
import http from 'node:http';
import { createInterface } from 'node:readline/promises';
import { spawn } from 'node:child_process';

const PORT = 8976;
const REDIRECT = `http://127.0.0.1:${PORT}`;
// The narrow scope: files this app created, and nothing else in the Drive.
const SCOPE = 'https://www.googleapis.com/auth/drive.file';

const rl = createInterface({ input: process.stdin, output: process.stdout });

console.log(`
Нужен OAuth-клиент Google. Если его ещё нет:

  1. https://console.cloud.google.com/projectcreate — создай проект.
  2. APIs & Services → Library → включи "Google Drive API".
  3. APIs & Services → OAuth consent screen → External.
     ВАЖНО: доведи его до "In production" (кнопка Publish app).
     У приложения в статусе Testing refresh-токен протухает через 7 дней.
     Добавь себя в Test users, если оставляешь Testing.
  4. Credentials → Create credentials → OAuth client ID → Desktop app.
  5. Скопируй Client ID и Client secret сюда.
`);

const clientId = (await rl.question('Client ID: ')).trim();
const clientSecret = (await rl.question('Client secret: ')).trim();
if (!clientId || !clientSecret) {
  console.error('Пусто — нечего делать.');
  process.exit(1);
}

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: clientId,
  redirect_uri: REDIRECT,
  response_type: 'code',
  scope: SCOPE,
  // Both are required to get a refresh token back: offline asks for one,
  // consent forces a fresh one even if this app was authorised before.
  access_type: 'offline',
  prompt: 'consent',
});

const code = await new Promise((resolve, reject) => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, REDIRECT);
    const got = url.searchParams.get('code');
    const err = url.searchParams.get('error');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<meta charset="utf-8"><body style="font:16px system-ui;padding:40px">
      ${got ? '✅ Готово — возвращайся в терминал.' : `❌ ${err || 'нет кода'}`}</body>`);
    server.close();
    got ? resolve(got) : reject(new Error(err || 'no code in redirect'));
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`\nОткрываю браузер. Если не откроется — зайди сюда вручную:\n\n${authUrl}\n`);
    const open = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'start' : 'xdg-open';
    spawn(open, [authUrl], { stdio: 'ignore', detached: true }).unref();
  });
  server.on('error', reject);
});

const r = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: REDIRECT,
    grant_type: 'authorization_code',
  }),
});
const tok = await r.json();
if (!r.ok || !tok.refresh_token) {
  console.error('\nОбмен кода не удался:', JSON.stringify(tok, null, 2));
  console.error('\nЕсли refresh_token не пришёл, а access_token есть — Google решил, что'
    + '\nдоступ уже выдавался. Отзови его на https://myaccount.google.com/permissions'
    + '\nи запусти скрипт заново.');
  process.exit(1);
}

console.log(`
Готово. Положи три секрета в воркер — по одному, значение вводится в ответ на запрос:

  npm run secret put GOOGLE_CLIENT_ID
  ${clientId}

  npm run secret put GOOGLE_CLIENT_SECRET
  ${clientSecret}

  npm run secret put GOOGLE_REFRESH_TOKEN
  ${tok.refresh_token}

Потом: npm run deploy
`);
rl.close();
