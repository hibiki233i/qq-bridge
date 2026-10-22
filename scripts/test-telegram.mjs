// Telegram 接入自检（全部离线：假 Bot API + 假 HTTP 代理 + 桥接 VM 脚手架）
//   1) 纯函数：配置规范化、会话 id、update → 事件
//   2) TelegramClient：发文字（引用 / @ / 超长切分）、429 重试、下载图片、token 不外泄、走 CONNECT 代理
//   3) 长轮询：offset 推进、同会话按序处理、401 停止
//   4) 桥接：白名单 / 管理员、发送分流、引用解析、图片下载、二代接口（发送 / QQ 专有接口拒绝）
//   5) 配置页：Telegram 字段的读写校验与「测试连接」
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  normalizeTelegramConfig, telegramConfigProblems, tgChatIdOf, tgConvId, isTelegramConvId,
  updateToEvent, createTelegramMessageCache, TelegramClient, startTelegramPolling
} from '../src/telegram.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { toForm, applyForm } from './config-gui.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BOT_TOKEN = '123456:' + 'A'.repeat(35);
const ME = { id: 7000, is_bot: true, first_name: '小鲸鱼', username: 'her_bot', can_read_all_group_messages: false };
// 1x1 PNG 的头部（签名 + IHDR），够 looksLikeImageBuffer / getImageDimensions 用
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
const NOW = 1_800_000_000;

// ── 假 Bot API ──────────────────────────────────────────────────────────
const botApi = { calls: [], updates: [], rateLimitOnce: true };
const apiServer = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => { raw += c; }).on('end', async () => {
    const reply = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    const fileMatch = /^\/file\/bot([^/]+)\/(.+)$/.exec(req.url);
    if (fileMatch) {
      botApi.calls.push({ method: 'FILE', path: fileMatch[2] });
      if (fileMatch[1] !== BOT_TOKEN) return reply(401, { ok: false });
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end(PNG);
    }
    const m = /^\/bot([^/]+)\/(\w+)$/.exec(req.url);
    if (!m) return reply(404, { ok: false, error_code: 404, description: 'Not Found' });
    const params = raw ? JSON.parse(raw) : {};
    botApi.calls.push({ method: m[2], params });
    if (m[1] !== BOT_TOKEN) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    switch (m[2]) {
      case 'getMe': return reply(200, { ok: true, result: ME });
      case 'getWebhookInfo': return reply(200, { ok: true, result: { url: '' } });
      case 'sendMessage':
        if (params.text === 'RATE' && botApi.rateLimitOnce) {
          botApi.rateLimitOnce = false;
          return reply(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
        }
        return reply(200, { ok: true, result: { message_id: 500 + botApi.calls.length, chat: { id: params.chat_id }, text: params.text } });
      case 'getFile':
        if (params.file_id === 'big') return reply(200, { ok: true, result: { file_id: 'big', file_size: 50 * 1024 * 1024, file_path: 'photos/big.png' } });
        if (params.file_id === 'evil') return reply(200, { ok: true, result: { file_id: 'evil', file_path: '../../etc/passwd' } });
        return reply(200, { ok: true, result: { file_id: params.file_id, file_size: PNG.length, file_path: 'photos/a.png' } });
      case 'getUpdates': {
        await sleep(30);
        const batch = botApi.updates.splice(0);
        return reply(200, { ok: true, result: batch });
      }
      default: return reply(400, { ok: false, error_code: 400, description: 'unknown method' });
    }
  });
});
await new Promise((r) => apiServer.listen(0, '127.0.0.1', r));
const API_BASE = `http://127.0.0.1:${apiServer.address().port}`;

// ── 假 HTTP 代理（只实现 CONNECT）──────────────────────────────────────────
const proxyLog = [];
const proxy = http.createServer((req, res) => { res.writeHead(405); res.end(); });
proxy.on('connect', (req, clientSocket, head) => {
  proxyLog.push(req.url);
  const [host, port] = req.url.split(':');
  const upstream = net.connect(Number(port), host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head?.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.on('error', () => clientSocket.destroy());
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const PROXY = `http://127.0.0.1:${proxy.address().port}`;

// ── 1. 纯函数 ──────────────────────────────────────────────────────────
await test('配置规范化：id 名单、管理员、默认值', () => {
  const c = normalizeTelegramConfig({ enabled: true, botToken: ` ${BOT_TOKEN} `, ownerId: '111', allow: { private: ['222', 'x', -5, 222], groups: ['-1001', '0', 'abc'] } });
  assert.equal(c.enabled, true);
  assert.equal(c.botToken, BOT_TOKEN);
  assert.equal(c.ownerId, 111);
  assert.deepEqual(c.allow.private, [222], '私聊只收正整数，去重');
  assert.deepEqual(c.allow.groups, [-1001], '群收负数，丢掉 0 和非数字');
  assert.equal(c.apiBase, 'https://api.telegram.org');
  assert.equal(c.pollTimeoutSec, 30);
  assert.equal(normalizeTelegramConfig(undefined).enabled, false, '没有 telegram 段 = 不启用');
  assert.throws(() => normalizeTelegramConfig({ ownerId: '-3' }), /ownerId/);
  assert.deepEqual(telegramConfigProblems(c), []);
  assert.match(telegramConfigProblems({ ...c, botToken: 'nope' }).join(), /botToken/);
  assert.match(telegramConfigProblems({ ...c, proxy: 'socks5://127.0.0.1:1080' }).join(), /HTTP 代理/);
});

await test('会话 id：tg<chat_id> 往返，和 QQ 号区分', () => {
  assert.equal(tgConvId(-1001234), 'tg-1001234');
  assert.equal(tgChatIdOf('tg-1001234'), -1001234);
  assert.equal(tgChatIdOf('tg123'), 123);
  assert.equal(tgChatIdOf('123'), null);
  assert.equal(tgChatIdOf('tg0'), null);
  assert.equal(tgChatIdOf('tg12x'), null);
  assert.equal(isTelegramConvId(123), false);
});

function msgUpdate(message, updateId = 1) {
  return { update_id: updateId, message: { date: NOW, message_id: 10, ...message } };
}
const privChat = { id: 111, type: 'private' };
const groupChat = { id: -100500, type: 'supergroup', title: '测试群' };
const alice = { id: 222, is_bot: false, first_name: 'Alice', last_name: 'W' };

await test('update → 事件：私聊文字', () => {
  const cache = createTelegramMessageCache();
  const r = updateToEvent(msgUpdate({ chat: privChat, from: { id: 111, first_name: '主人' }, text: '在吗' }), ME, { cache, now: NOW * 1000 });
  assert.equal(r.kind, 'private');
  assert.equal(r.id, 'tg111');
  assert.equal(r.event.user_id, 'tg111');
  assert.equal(r.event.self_id, 'tg7000');
  assert.equal(r.event.platform, 'telegram');
  assert.deepEqual(r.event.message, [{ type: 'text', data: { text: '在吗' } }]);
  assert.equal(r.event.sender.nickname, '主人');
  assert.equal(cache.get(111, 10).text, '在吗', '收到的消息记进引用缓存');
});

await test('update → 事件：群里 @bot 变成 at 段，text_mention 记名字', () => {
  const cache = createTelegramMessageCache();
  const text = '@her_bot 你看 Bob 说的';
  const r = updateToEvent(msgUpdate({
    chat: groupChat, from: alice, text,
    entities: [
      { type: 'mention', offset: 0, length: 8 },
      { type: 'text_mention', offset: 12, length: 3, user: { id: 333, first_name: 'Bob' } }
    ]
  }), ME, { cache, now: NOW * 1000 });
  assert.equal(r.kind, 'group');
  assert.equal(r.id, 'tg-100500');
  assert.equal(r.event.group_id, 'tg-100500');
  assert.deepEqual(r.event.message, [
    { type: 'at', data: { qq: 'tg7000' } },
    { type: 'text', data: { text: ' 你看 ' } },
    { type: 'at', data: { qq: 'tg333' } },
    { type: 'text', data: { text: ' 说的' } }
  ]);
  assert.equal(cache.nameOf(-100500, 'tg333'), 'Bob');
  assert.equal(cache.nameOf(-100500, 'tg222'), 'Alice W');
});

await test('update → 事件：命令去掉 @bot 后缀；发给别的 bot 的命令、/start、积压旧消息都跳过', () => {
  const r = updateToEvent(msgUpdate({ chat: groupChat, from: alice, text: '/reset@her_bot now', entities: [{ type: 'bot_command', offset: 0, length: 14 }] }), ME, { now: NOW * 1000 });
  assert.deepEqual(r.event.message, [{ type: 'text', data: { text: '/reset now' } }]);
  assert.ok(updateToEvent(msgUpdate({ chat: groupChat, from: alice, text: '/reset@other_bot' }), ME, { now: NOW * 1000 }).skip);
  assert.ok(updateToEvent(msgUpdate({ chat: privChat, from: alice, text: '/start' }), ME, { now: NOW * 1000 }).skip);
  assert.match(updateToEvent(msgUpdate({ chat: privChat, from: alice, text: 'hi' }), ME, { now: (NOW + 3600) * 1000 }).skip, /积压/);
  assert.ok(updateToEvent(msgUpdate({ chat: { id: -1, type: 'channel' }, from: alice, text: 'hi' }), ME, { now: NOW * 1000 }).skip);
  assert.equal(updateToEvent({ update_id: 1, edited_message: {} }, ME), null);
});

await test('update → 事件：图片挑不超限的最大尺寸；图片文件、静态贴纸、引用', () => {
  const cache = createTelegramMessageCache();
  const r = updateToEvent(msgUpdate({
    chat: groupChat, from: alice, caption: '看图',
    photo: [{ file_id: 's', file_size: 1000 }, { file_id: 'm', file_size: 5000 }, { file_id: 'l', file_size: 99_000_000 }],
    reply_to_message: { message_id: 9, from: { id: 7000, is_bot: true, first_name: '小鲸鱼' }, text: '我刚说的话', date: NOW }
  }), ME, { cache, now: NOW * 1000, maxMediaBytes: 10_000 });
  assert.deepEqual(r.event.message, [
    { type: 'reply', data: { id: '9' } },
    { type: 'image', data: { file: 'tgfile:m', url: '' } },
    { type: 'text', data: { text: '看图' } }
  ]);
  assert.deepEqual(cache.get(-100500, 9), { userId: 'tg7000', sender: '小鲸鱼', text: '我刚说的话' }, '被引用的消息也记进缓存');
  const doc = updateToEvent(msgUpdate({ chat: privChat, from: alice, document: { file_id: 'd', mime_type: 'image/png', file_name: 'a.png' } }), ME, { now: NOW * 1000 });
  assert.equal(doc.event.message[0].data.file, 'tgfile:d');
  const sticker = updateToEvent(msgUpdate({ chat: privChat, from: alice, sticker: { file_id: 'st', emoji: '😀', is_animated: false, is_video: false } }), ME, { now: NOW * 1000 });
  assert.equal(sticker.event.message[0].data.summary, '😀');
  const anim = updateToEvent(msgUpdate({ chat: privChat, from: alice, sticker: { file_id: 'st', emoji: '😀', is_animated: true } }), ME, { now: NOW * 1000 });
  assert.deepEqual(anim.event.message, [{ type: 'text', data: { text: '[贴纸:😀]' } }]);
});

// ── 2. TelegramClient ─────────────────────────────────────────────────
await test('发文字：引用、@ 实体、超长切分；429 等一下重试一次', async () => {
  const c = new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE });
  botApi.calls.length = 0;
  const sent = await c.sendText(-100500, '你好', { replyTo: 9, mention: { userId: 222, name: 'Alice' } });
  const call = botApi.calls.find((x) => x.method === 'sendMessage');
  assert.equal(call.params.text, 'Alice 你好');
  assert.deepEqual(call.params.entities, [{ type: 'text_mention', offset: 0, length: 5, user: { id: 222 } }]);
  assert.deepEqual(call.params.reply_parameters, { message_id: 9, allow_sending_without_reply: true });
  assert.equal(call.params.parse_mode, undefined, '不开 parse_mode');
  assert.ok(sent.message_id > 0);
  botApi.calls.length = 0;
  await c.sendText(1, 'x'.repeat(8500));
  assert.deepEqual(botApi.calls.filter((x) => x.method === 'sendMessage').map((x) => x.params.text.length), [4000, 4000, 500]);
  botApi.calls.length = 0;
  const t0 = Date.now();
  await c.sendText(1, 'RATE');
  assert.equal(botApi.calls.filter((x) => x.method === 'sendMessage').length, 2, '429 后重试一次');
  assert.ok(Date.now() - t0 >= 900, '按 retry_after 等待');
});

await test('下载图片：大小上限、路径校验；错误信息里没有 token', async () => {
  const c = new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE });
  const buf = await c.downloadFile('ok', 1024 * 1024);
  assert.deepEqual(buf, PNG);
  await assert.rejects(c.downloadFile('big', 1024 * 1024), /超过上限/);
  await assert.rejects(c.downloadFile('evil', 1024 * 1024), /路径无效/);
  const bad = new TelegramClient({ botToken: BOT_TOKEN, apiBase: 'http://127.0.0.1:1' });
  const err = await bad.getMe().catch((e) => e);
  assert.equal(err.code, 'network');
  assert.ok(!String(err.message).includes(BOT_TOKEN), `网络错误不得带出 token：${err.message}`);
  const wrong = new TelegramClient({ botToken: '999999:' + 'B'.repeat(35), apiBase: API_BASE });
  const e401 = await wrong.getMe().catch((e) => e);
  assert.equal(e401.code, 401);
  assert.ok(!String(e401.message).includes('999999:'), 'API 错误不得带出 token');
});

await test('走 HTTP CONNECT 代理', async () => {
  proxyLog.length = 0;
  const c = new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE, proxy: PROXY });
  const me = await c.getMe();
  assert.equal(me.username, 'her_bot');
  assert.equal(proxyLog.length, 1, '请求必须经过代理');
  assert.equal(proxyLog[0], `127.0.0.1:${apiServer.address().port}`);
  const dead = new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE, proxy: 'http://127.0.0.1:1' });
  const err = await dead.getMe().catch((e) => e);
  assert.match(err.message, /连不上代理/);
});

// ── 3. 长轮询 ─────────────────────────────────────────────────────────
await test('长轮询：offset 推进，同一会话按到达顺序处理', async () => {
  const c = new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE });
  botApi.calls.length = 0;
  botApi.updates.push(
    msgUpdate({ chat: privChat, from: alice, text: 'a' }, 41),
    msgUpdate({ chat: privChat, from: alice, text: 'b' }, 42)
  );
  const seen = [];
  const stop = startTelegramPolling({
    client: c, timeoutSec: 1, log: () => {},
    onUpdate: async (u) => {
      if (u.message.text === 'a') await sleep(80); // 第一条处理得慢，第二条也必须排在后面
      seen.push(u.message.text);
    }
  });
  for (let i = 0; i < 40 && seen.length < 2; i++) await sleep(25);
  await sleep(100);
  stop();
  assert.deepEqual(seen, ['a', 'b']);
  const offsets = botApi.calls.filter((x) => x.method === 'getUpdates').map((x) => x.params.offset);
  assert.ok(offsets.includes(43), `确认过的 update 之后 offset 要变成 43（实际 ${offsets}）`);
  assert.deepEqual(botApi.calls.find((x) => x.method === 'getUpdates').params.allowed_updates, ['message']);
});

await test('长轮询：token 无效就停下并说清楚', async () => {
  const logs = [];
  const c = new TelegramClient({ botToken: '999999:' + 'B'.repeat(35), apiBase: API_BASE });
  const stop = startTelegramPolling({ client: c, timeoutSec: 1, log: (...a) => logs.push(a.join(' ')), onUpdate: async () => {} });
  for (let i = 0; i < 40 && !logs.length; i++) await sleep(25);
  stop();
  assert.match(logs.join('\n'), /botToken 无效/);
});

// ── 4. 桥接 ───────────────────────────────────────────────────────────
const CONSOLE = { 'x-console-token': 'fixture-console-token' };
function consoleCall(port, pathname, { method = 'GET', body, token } = {}) {
  const headers = { 'content-type': 'application/json', ...CONSOLE, ...(token ? { 'x-agent-token': token } : {}) };
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(data); } catch {} resolve({ status: res.statusCode, json, body: data }); });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}
async function withServer(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((r) => server.once('listening', r));
  try { await run(server.address().port); } finally { await new Promise((r) => server.close(r)); }
}

const TG_CONFIG = { telegram: { enabled: true, botToken: BOT_TOKEN, ownerId: 111, allow: { private: [222], groups: [-100500] } } };
function fakeTelegram(h) {
  const calls = [];
  h.tg.client = {
    sendText: async (chatId, text, opts) => { calls.push({ chatId, text, opts }); return { message_id: 900 + calls.length, text }; },
    downloadFile: async (fileId, max) => { calls.push({ download: fileId, max }); return PNG; },
    redact: (s) => s
  };
  h.tg.me = { id: 7000, username: 'her_bot', first_name: '小鲸鱼' };
  return calls;
}
const tgEvent = (r) => r.event;

await test('桥接：白名单与管理员（Telegram 名单独立，不跟随 allowAllWhenEmpty）', async () => {
  const h = await bridgeHarness({ config: { ...TG_CONFIG, allowAllWhenEmpty: true } });
  try {
    fakeTelegram(h);
    h.setMode('chat');
    assert.equal(h.modeAllowed('private:tg222', 'private', 'tg222', h.cfg, 'chat'), true, '名单里的私聊放行');
    assert.equal(h.modeAllowed('private:tg111', 'private', 'tg111', h.cfg, 'chat'), true, '管理员私聊总是放行');
    assert.equal(h.modeAllowed('group:tg-100500', 'group', 'tg-100500', h.cfg, 'chat'), true);
    assert.equal(h.modeAllowed('private:tg999', 'private', 'tg999', h.cfg, 'chat'), false, 'allowAllWhenEmpty 不放行 Telegram 陌生人');
    assert.equal(h.modeAllowed('private:tg111', 'private', 'tg111', h.cfg, 'closed-agent'), false, '封闭 agent 模式仍只认 QQ 管理员');
    assert.equal(h.isOwnerUserId('tg111'), true);
    assert.equal(h.isOwnerUserId('111'), false, 'Telegram 管理员 id 不能冒充 QQ 号');
    assert.equal(h.isOwnerUserId('123'), true, 'QQ 管理员不受影响');
    assert.equal(h.isSessionAllowedInCurrentMode('private:tg-5'), false, 'Telegram 私聊 id 不会是负数');
    h.cfg.telegram.enabled = false;
    assert.equal(h.modeAllowed('private:tg222', 'private', 'tg222', h.cfg, 'chat'), false, '没启用就一律不理');
  } finally { await h.close(); }
});

await test('桥接：一代模式收 Telegram 消息投给 DSH，回复发回 Telegram，QQ 不受影响', async () => {
  const h = await bridgeHarness({ config: TG_CONFIG });
  try {
    const calls = fakeTelegram(h);
    h.setMode('chat');
    const r = updateToEvent(msgUpdate({ chat: privChat, from: { id: 111, first_name: '主人' }, text: '早' }), h.tg.me, { cache: h.tg.cache, now: NOW * 1000 });
    await h.handleIncoming(r.kind, r.id, tgEvent(r), h.cfg);
    const prompt = h.calls.prompts.at(-1);
    assert.ok(prompt, '应当投递给 DSH');
    assert.match(JSON.stringify(prompt.content), /【管理员】早/);
    const stranger = updateToEvent(msgUpdate({ chat: { id: 999, type: 'private' }, from: { id: 999, first_name: 'X' }, text: 'hi' }), h.tg.me, { now: NOW * 1000 });
    const before = h.calls.prompts.length;
    await h.handleIncoming(stranger.kind, stranger.id, tgEvent(stranger), h.cfg);
    assert.equal(h.calls.prompts.length, before, '不在名单里的不投递');
    await h.sendToQQ('private:tg111', '早呀');
    const texts = calls.filter((c) => c.text);
    assert.deepEqual(texts.map((c) => c.text), [h.cfg.ackMessage, '早呀'], '先是「收到」回执（ackMessage），再是回复');
    assert.ok(texts.every((c) => c.chatId === 111), '都发回同一个私聊');
    assert.equal(h.calls.sent.length, 0, '不能发到 QQ');
    await h.sendToQQ('private:123', 'qq 这边');
    assert.equal(h.calls.sent.at(-1)?.id, 123, 'QQ 发送照旧');
    assert.equal(calls.filter((c) => c.text).length, 2, 'QQ 消息不能发到 Telegram');
  } finally { await h.close(); }
});

await test('桥接：引用解析、@ 名字、图片下载都走 Telegram', async () => {
  const h = await bridgeHarness({ config: TG_CONFIG });
  try {
    const calls = fakeTelegram(h);
    h.tg.cache.remember(-100500, 9, { userId: 'tg7000', sender: '小鲸鱼', text: '我刚说的' });
    const info = await h.resolveReplyInfo('group', 'tg-100500', '9', 'tg7000');
    // VM 里造的对象原型不同，按 JSON 比
    assert.deepEqual(JSON.parse(JSON.stringify(info)), { sender: '小鲸鱼', text: '我刚说的', userId: 'tg7000' });
    assert.equal(await h.resolveReplyInfo('group', 'tg-100501', '9'), null, '别的会话查不到');
    const text = await h.segmentsToText([{ type: 'at', data: { qq: 'tg7000' } }, { type: 'text', data: { text: ' 在吗' } }], {
      resolveAtName: async (qq) => (qq === 'tg7000' ? h.tg.me.first_name : null)
    });
    assert.equal(text, '@小鲸鱼 在吗');
    const img = await h.fetchOneBotImage({ kind: 'image', file: 'tgfile:abc' });
    assert.ok(img?.buffer?.length, '应当下载到图片');
    assert.equal(img.mimeType, 'image/png');
    assert.equal(calls.at(-1).download, 'abc');
    assert.equal(h.calls.images.length, 0, '不能去问 QQ 网关 get_image');
  } finally { await h.close(); }
});

await test('桥接：二代模式 Telegram 会话能入库、能发送，QQ 专有接口明确拒绝', async () => {
  const h = await bridgeHarness({ config: TG_CONFIG });
  try {
    const calls = fakeTelegram(h);
    h.setMode('reserved2');
    const r = updateToEvent(msgUpdate({ chat: groupChat, from: alice, text: '@her_bot 来聊天', entities: [{ type: 'mention', offset: 0, length: 8 }] }), h.tg.me, { cache: h.tg.cache, now: NOW * 1000 });
    await h.handleIncoming(r.kind, r.id, tgEvent(r), h.cfg);
    const st = h.getSocialV2State('group:tg-100500');
    assert.ok(st.unread.some((m) => /来聊天/.test(m.text)), '消息进了未读');
    assert.ok(st.unread.some((m) => String(m.userId) === 'tg222'), '记下发送者');
    const prompt = h.buildWakePromptV2('group:tg-100500', 'atMention');
    assert.match(prompt, /Telegram 上的会话/);
    assert.ok(!/你在 QQ 上的昵称/.test(prompt), 'Telegram 会话不用 QQ 身份说明');
    await withServer(h, async (port) => {
      const sent = await consoleCall(port, '/api/socialV2/send-message', {
        method: 'POST', token: st.agentToken, body: { key: 'group:tg-100500', messages: ['来啦'] }
      });
      assert.equal(sent.status, 200, sent.body);
      assert.deepEqual(calls.filter((c) => c.text).map((c) => [c.chatId, c.text]), [[-100500, '来啦']]);
      const reply = await consoleCall(port, '/api/send/group', {
        method: 'POST', token: st.agentToken, body: { groupId: 'tg-100500', message: '回你', replyToMessageId: r.event.message_id, atUserId: 'tg222', token: st.agentToken }
      });
      assert.equal(reply.status, 200, reply.body);
      const last = calls.filter((c) => c.text).at(-1);
      assert.equal(last.opts.replyTo, r.event.message_id);
      assert.deepEqual({ ...last.opts.mention }, { userId: 222, name: 'Alice W' }, '@ 转成 text_mention，名字取自收到消息时记下的');
      const poke = await consoleCall(port, '/api/socialV2/send-poke', {
        method: 'POST', token: st.agentToken, body: { key: 'group:tg-100500', userId: 'tg222' }
      });
      assert.equal(poke.status, 400);
      assert.match(poke.json.error, /Telegram/);
      const sticker = await consoleCall(port, '/api/socialV2/send-sticker', {
        method: 'POST', token: st.agentToken, body: { key: 'group:tg-100500', sticker: '1' }
      });
      assert.equal(sticker.status, 400);
      const wrongToken = await consoleCall(port, '/api/socialV2/send-message', {
        method: 'POST', token: h.getSocialV2State('group:456').agentToken, body: { key: 'group:tg-100500', messages: ['x'] }
      });
      assert.equal(wrongToken.status, 403, 'QQ 会话的令牌不能发到 Telegram 会话');
    });
    assert.equal(h.calls.sent.length, 0, '全程没有发到 QQ');
  } finally { await h.close(); }
});

await test('桥接：telegramSend 把自己发的话记进缓存（别人引用她时认得出来）', async () => {
  const h = await bridgeHarness({ config: TG_CONFIG });
  try {
    fakeTelegram(h);
    const sent = await h.telegramSend('tg-100500', '记住我');
    const info = await h.resolveReplyInfo('group', 'tg-100500', String(sent.message_id), 'tg7000');
    assert.equal(info.userId, 'tg7000');
    await assert.rejects(h.telegramSend('tg-100500', 'x', { atUserId: 'abc' }), /atUserId/);
    h.tg.me = null;
    await assert.rejects(h.telegramSend('tg-100500', 'x'), /未连接/);
  } finally { await h.close(); }
});

// ── 5. 配置页 ─────────────────────────────────────────────────────────
await test('配置页：Telegram 字段读写与校验', () => {
  const file = { ownerQQ: 10001, allow: { private: [10001], groups: [] }, telegram: { enabled: false, apiBase: 'http://mirror', pollTimeoutSec: 20 } };
  const f = toForm(file);
  assert.equal(f.telegram.enabled, false);
  const r = applyForm(file, { ...f, telegram: { enabled: true, botToken: BOT_TOKEN, proxy: 'http://127.0.0.1:7890/', ownerId: '111', allowPrivate: ['222', '222'], allowGroups: ['-1001234567890'] } });
  assert.ok(!r.errors, JSON.stringify(r.errors));
  assert.deepEqual(r.file.telegram, {
    enabled: true, apiBase: 'http://mirror', pollTimeoutSec: 20, botToken: BOT_TOKEN, proxy: 'http://127.0.0.1:7890',
    ownerId: 111, allow: { private: [222], groups: [-1001234567890] }
  }, '其余 telegram 字段保留，名单去重存数字');
  const bad = applyForm(file, { ...f, telegram: { enabled: true, botToken: 'nope', proxy: 'socks5://x', ownerId: '-1', allowPrivate: ['-5'], allowGroups: ['abc'] } });
  assert.equal(bad.errors.length, 5, JSON.stringify(bad.errors));
  const none = applyForm({ ownerQQ: 10001, allow: {} }, toForm({ ownerQQ: 10001, allow: {} }));
  assert.ok(!('telegram' in none.file), '原来没有、也没填，就不加 telegram 段');
  const noToken = applyForm(file, { ...f, telegram: { ...f.telegram, enabled: true } });
  assert.match(noToken.errors.join(), /Bot token/);
});

await test('配置页：测试连接（通过代理访问 Bot API）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-gui-tg-'));
  const CFG = path.join(tmp, 'config.json');
  fs.writeFileSync(CFG, JSON.stringify({ telegram: { apiBase: API_BASE } }));
  const child = spawn(process.execPath, [path.join(__dirname, 'config-gui.mjs'), '--no-open', '--config', CFG], { stdio: ['ignore', 'pipe', 'inherit'] });
  try {
    const m = await new Promise((resolve, reject) => {
      let out = '';
      child.stdout.on('data', (c) => { out += c; const x = /http:\/\/127\.0\.0\.1:(\d+)\/#t=([0-9a-f]+)/.exec(out); if (x) resolve(x); });
      child.on('exit', () => reject(new Error('config-gui 提前退出')));
    });
    const post = (body) => fetch(`http://127.0.0.1:${m[1]}/api/test/telegram`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-config-token': m[2] }, body: JSON.stringify(body)
    }).then((r) => r.json());
    proxyLog.length = 0;
    const good = await post({ botToken: BOT_TOKEN, proxy: PROXY });
    assert.equal(good.ok, true, JSON.stringify(good));
    assert.equal(good.bot, '@her_bot（小鲸鱼）');
    assert.equal(good.readsAllGroupMessages, false);
    assert.equal(good.webhook, false);
    assert.equal(proxyLog.length, 2, 'getMe 和 getWebhookInfo 都走代理');
    const wrong = await post({ botToken: '999999:' + 'B'.repeat(35) });
    assert.match(wrong.error, /token 无效/);
    const deadProxy = await post({ botToken: BOT_TOKEN, proxy: 'http://127.0.0.1:1' });
    assert.match(deadProxy.error, /代理/);
    const fmt = await post({ botToken: 'x' });
    assert.match(fmt.error, /格式/);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

apiServer.close();
proxy.close();
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
