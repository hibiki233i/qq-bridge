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
  normalizeTelegramConfig, normalizeTelegramLinks, telegramConfigProblems, tgChatIdOf, tgConvId, isTelegramConvId,
  updateToEvent, createTelegramMessageCache, TelegramClient, startTelegramPolling
} from '../src/telegram.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { toForm, applyForm } from './config-gui.mjs';
import {
  stickerSetNames, stickerSetTag, emojiListFor, keywordsFor, isAnimatedGif, cleanTgStickerRef,
  createTgStickerManager, loadTgStickerStore, SET_LIMIT, convertToSticker
} from '../src/tg-stickers.js';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';

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
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([1, 0, 1, 0, 0, 0, 0]), Buffer.alloc(20)]);

/** 极简 multipart 解析：够测试用（字段名 → 文本，文件 → { filename, contentType, buffer }） */
function parseMultipart(buf, contentType) {
  const boundary = /boundary=(.+)$/.exec(contentType)[1];
  const out = {};
  const sep = Buffer.from(`--${boundary}`);
  let pos = buf.indexOf(sep);
  while (pos >= 0) {
    const next = buf.indexOf(sep, pos + sep.length);
    if (next < 0) break;
    const part = buf.subarray(pos + sep.length + 2, next - 2);
    const headEnd = part.indexOf('\r\n\r\n');
    const head = part.subarray(0, headEnd).toString();
    const body = part.subarray(headEnd + 4);
    const name = /name="([^"]+)"/.exec(head)[1];
    const filename = /filename="([^"]+)"/.exec(head)?.[1];
    out[name] = filename ? { filename, contentType: /Content-Type: (.+)/.exec(head)[1], buffer: Buffer.from(body) } : body.toString();
    pos = next;
  }
  return out;
}
const NOW = 1_800_000_000;

// ── 假 Bot API ──────────────────────────────────────────────────────────
const botApi = { calls: [], updates: [], rateLimitOnce: true, sets: new Map(), seq: 0 };
const newSticker = (input) => {
  botApi.seq += 1;
  return {
    file_id: `SETFILE${botApi.seq}xxxxxxxxxx`, file_unique_id: `SU${botApi.seq}xx`, source: input.sticker,
    is_animated: input.format === 'animated', is_video: input.format === 'video', emoji: input.emoji_list?.[0],
    ...(input.format === 'static' ? {} : { thumbnail: { file_id: `THUMB${botApi.seq}xxxxxxxxxx` } })
  };
};
const apiServer = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => { chunks.push(c); }).on('end', async () => {
    const rawBuf = Buffer.concat(chunks);
    const isMultipart = String(req.headers['content-type'] ?? '').startsWith('multipart/form-data');
    const raw = isMultipart ? '' : rawBuf.toString();
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
    const params = isMultipart ? parseMultipart(rawBuf, req.headers['content-type']) : (raw ? JSON.parse(raw) : {});
    botApi.calls.push({ method: m[2], params });
    if (m[1] !== BOT_TOKEN) return reply(401, { ok: false, error_code: 401, description: 'Unauthorized' });
    switch (m[2]) {
      case 'getMe': return reply(200, { ok: true, result: ME });
      case 'getWebhookInfo': return reply(200, { ok: true, result: { url: '' } });
      case 'sendMessage':
        if (params.text === 'RATE10') {
          return reply(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 10', parameters: { retry_after: 10 } });
        }
        if (params.text === 'RATE' && botApi.rateLimitOnce) {
          botApi.rateLimitOnce = false;
          return reply(429, { ok: false, error_code: 429, description: 'Too Many Requests: retry after 1', parameters: { retry_after: 1 } });
        }
        return reply(200, { ok: true, result: { message_id: 500 + botApi.calls.length, chat: { id: params.chat_id }, text: params.text } });
      case 'sendPhoto':
      case 'sendAnimation':
        return reply(200, { ok: true, result: { message_id: 700 + botApi.calls.length, chat: { id: Number(params.chat_id) } } });
      case 'getFile':
        if (params.file_id === 'big') return reply(200, { ok: true, result: { file_id: 'big', file_size: 50 * 1024 * 1024, file_path: 'photos/big.png' } });
        if (params.file_id === 'evil') return reply(200, { ok: true, result: { file_id: 'evil', file_path: '../../etc/passwd' } });
        return reply(200, { ok: true, result: { file_id: params.file_id, file_size: PNG.length, file_path: 'photos/a.png' } });
      case 'getUpdates': {
        await sleep(30);
        const batch = botApi.updates.splice(0);
        return reply(200, { ok: true, result: batch });
      }
      case 'sendSticker':
        return reply(200, { ok: true, result: { message_id: 800 + botApi.calls.length, chat: { id: params.chat_id }, sticker: { file_id: params.sticker } } });
      case 'uploadStickerFile': {
        botApi.seq += 1;
        return reply(200, { ok: true, result: { file_id: `UPLOADED${botApi.seq}xxxxxxxxxx`, file_unique_id: `UP${botApi.seq}xx` } });
      }
      case 'createNewStickerSet':
        if (botApi.sets.has(params.name)) return reply(400, { ok: false, error_code: 400, description: 'Bad Request: sticker set name is already occupied' });
        botApi.sets.set(params.name, { name: params.name, title: params.title, owner: params.user_id, stickers: params.stickers.map(newSticker) });
        return reply(200, { ok: true, result: true });
      case 'addStickerToSet': {
        const set = botApi.sets.get(params.name);
        if (!set) return reply(400, { ok: false, error_code: 400, description: 'Bad Request: STICKERSET_INVALID' });
        if (!set.stickers.some((x) => x.source === params.sticker.sticker)) set.stickers.push(newSticker(params.sticker));
        return reply(200, { ok: true, result: true });
      }
      case 'getStickerSet': {
        const set = botApi.sets.get(params.name);
        if (!set) return reply(400, { ok: false, error_code: 400, description: 'Bad Request: STICKERSET_INVALID' });
        return reply(200, { ok: true, result: { name: set.name, title: set.title, sticker_type: 'regular', stickers: set.stickers } });
      }
      case 'deleteStickerFromSet': {
        for (const set of botApi.sets.values()) {
          const i = set.stickers.findIndex((x) => x.file_id === params.sticker);
          if (i >= 0) { set.stickers.splice(i, 1); return reply(200, { ok: true, result: true }); }
        }
        return reply(400, { ok: false, error_code: 400, description: 'Bad Request: STICKER_INVALID' });
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
  const badOwner = normalizeTelegramConfig({ enabled: true, botToken: BOT_TOKEN, ownerId: '@hao' });
  assert.equal(badOwner.ownerId, null, 'ownerId 写错不抛错（抛错会连 QQ 一起起不来）');
  assert.match(telegramConfigProblems(badOwner).join(), /ownerId「@hao」/, '但启用时要拦住 Telegram 并说明原因');
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

await test('update → 事件：话题群不把自动引用当真；GIF 只算一次', () => {
  const cache = createTelegramMessageCache();
  const r = updateToEvent(msgUpdate({
    chat: { ...groupChat, is_forum: true }, from: alice, text: 'hello', is_topic_message: true, message_thread_id: 40,
    reply_to_message: { message_id: 40, date: NOW, from: alice, forum_topic_created: { name: '闲聊' } }
  }), ME, { cache, now: NOW * 1000 });
  assert.deepEqual(r.event.message, [{ type: 'text', data: { text: 'hello' } }], '话题创建消息不是引用');
  assert.equal(cache.threadOf(-100500), 40, '记下话题 id，回复发回同一个话题');
  updateToEvent(msgUpdate({ chat: groupChat, from: alice, text: 'general' }), ME, { cache, now: NOW * 1000 });
  assert.equal(cache.threadOf(-100500), null, '在 General 说话就回到 General');
  const gif = updateToEvent(msgUpdate({ chat: privChat, from: alice, animation: { file_id: 'g' }, document: { file_id: 'g', file_name: 'x.gif.mp4', mime_type: 'video/mp4' } }), ME, { now: NOW * 1000 });
  assert.deepEqual(gif.event.message, [{ type: 'video', data: {} }]);
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
  await c.sendText(1, 'x'.repeat(3999) + '😀' + 'y'.repeat(10), { threadId: 40 });
  const split = botApi.calls.filter((x) => x.method === 'sendMessage');
  assert.deepEqual(split.map((x) => x.params.text.length), [3999, 12], '不把 emoji 切成两半');
  assert.ok(split.every((x) => x.params.text.isWellFormed()), '每段都是完整的 UTF-16');
  assert.equal(split[0].params.message_thread_id, 40, '话题 id 带上');
  botApi.calls.length = 0;
  const t1 = Date.now();
  const longWait = await c.sendText(1, 'RATE10').catch((e) => e);
  assert.equal(longWait.code, 429);
  assert.ok(Date.now() - t1 < 2000, '要等很久的限流不原地重试（否则桥接已判失败、重试还在后台发出去）');
  assert.equal(botApi.calls.filter((x) => x.method === 'sendMessage').length, 1);
  botApi.calls.length = 0;
  const t0 = Date.now();
  await c.sendText(1, 'RATE');
  assert.equal(botApi.calls.filter((x) => x.method === 'sendMessage').length, 2, '429 后重试一次');
  assert.ok(Date.now() - t0 >= 900, '按 retry_after 等待');
});

await test('发图：PNG 用 sendPhoto、GIF 用 sendAnimation（multipart 上传），@ 放在图片说明里', async () => {
  const c = new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE });
  botApi.calls.length = 0;
  await c.sendImage(-100500, PNG, { replyTo: 9, threadId: 40, mention: { userId: 222, name: 'Alice' } });
  const photo = botApi.calls.find((x) => x.method === 'sendPhoto');
  assert.ok(photo, '应当调用 sendPhoto');
  assert.equal(photo.params.chat_id, '-100500');
  assert.deepEqual(photo.params.photo.buffer, PNG, '上传的就是这张图的字节');
  assert.equal(photo.params.photo.contentType, 'image/png');
  assert.equal(photo.params.caption, 'Alice');
  assert.deepEqual(JSON.parse(photo.params.caption_entities), [{ type: 'text_mention', offset: 0, length: 5, user: { id: 222 } }]);
  assert.deepEqual(JSON.parse(photo.params.reply_parameters), { message_id: 9, allow_sending_without_reply: true });
  assert.equal(photo.params.message_thread_id, '40');
  botApi.calls.length = 0;
  const sent = await c.sendImage(111, GIF);
  const anim = botApi.calls.find((x) => x.method === 'sendAnimation');
  assert.ok(anim, 'GIF 走 sendAnimation 才会动');
  assert.equal(anim.params.animation.filename, 'sticker.gif');
  assert.equal(anim.params.caption, undefined, '没 @ 人就不带说明文字');
  assert.ok(sent.message_id > 0);
  await assert.rejects(c.sendImage(111, Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)])), /10 MB/);
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
// 打开贴纸包的配置（默认是关的）
const TG_STICKER_CONFIG = { telegram: { ...TG_CONFIG.telegram, stickers: { favorites: true, syncQQ: true } } };
const TAG = stickerSetTag(7000, 111);
const FAV_SET = `her_fav_${TAG}_by_her_bot`;
const QQ_SET = `her_qq_${TAG}_by_her_bot`;
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

await test('桥接：Telegram 卡住时 QQ 照常发送（两条发送队列分开）', async () => {
  const h = await bridgeHarness({ config: TG_CONFIG });
  try {
    fakeTelegram(h);
    h.tg.client.sendText = () => new Promise(() => {}); // 代理接了连接却不回
    void h.sendToQQ('private:tg111', '卡住');
    const t0 = Date.now();
    await h.sendToQQ('private:123', 'QQ 不受影响');
    assert.ok(Date.now() - t0 < 2000, `QQ 发送被 Telegram 堵住了 ${Date.now() - t0}ms`);
    assert.equal(h.calls.sent.at(-1)?.id, 123);
  } finally { await h.close(); }
});

await test('桥接：Telegram ownerId 写错不影响桥接启动', async () => {
  const h = await bridgeHarness({ config: { telegram: { enabled: false, ownerId: '@hao' } } });
  try {
    assert.equal(h.cfg.telegram.ownerId, null);
    assert.equal(h.isOwnerUserId('123'), true, 'QQ 管理员照常');
  } finally { await h.close(); }
});

await test('桥接：Telegram 群里叫 bot 的名字能唤醒（不是 QQ 昵称）', async () => {
  const h = await bridgeHarness({ config: TG_CONFIG });
  try {
    fakeTelegram(h);
    h.setSelfIdentity('QQ昵称', '10001');
    h.tg.me.first_name = '小樰'; // 不用默认关键词里的词，免得被关键词触发混淆
    const event = { platform: 'telegram', self_id: 'tg7000', user_id: 'tg222', message: [{ type: 'text', data: { text: '小樰你觉得呢' } }] };
    assert.equal(h.isDirectAddress('小樰你觉得呢', event, 'group'), true);
    const st = h.getSocialV2State('group:tg-100500');
    st.wakeConfig.triggers = { nameMention: true };
    assert.equal(h.evaluateWakeTriggerV2('group:tg-100500', st, event, 'group', '小樰你觉得呢', '小樰你觉得呢', false), 'nameMention');
    const qqEvent = { self_id: '10001', user_id: '5', message: [] };
    const qqSt = h.getSocialV2State('group:456');
    qqSt.wakeConfig.triggers = { nameMention: true }; // 只留名字触发：默认配置带随机概率，会让结果不稳定
    assert.equal(h.evaluateWakeTriggerV2('group:456', qqSt, qqEvent, 'group', '小樰', '小樰', false), null, 'QQ 群仍按 QQ 昵称');
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
      const wrongToken = await consoleCall(port, '/api/socialV2/send-message', {
        method: 'POST', token: h.getSocialV2State('group:456').agentToken, body: { key: 'group:tg-100500', messages: ['x'] }
      });
      assert.equal(wrongToken.status, 403, 'QQ 会话的令牌不能发到 Telegram 会话');
    });
    assert.equal(h.calls.sent.length, 0, '全程没有发到 QQ');
  } finally { await h.close(); }
});

await test('桥接：表情包工具在 Telegram 会话里发成图片，不走 QQ 网关', async () => {
  const qqHttp = [];
  const h = await bridgeHarness({ config: TG_CONFIG, globals: {
    safeFetchBuffer: async () => ({ buffer: GIF }),
    fetch: async (url, init) => { qqHttp.push(String(url)); return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }; }
  } });
  try {
    const calls = fakeTelegram(h);
    h.tg.client.sendImage = async (chatId, buffer, opts) => { calls.push({ image: true, chatId, buffer, opts }); return { message_id: 777 }; };
    h.tg.cache.rememberName(-100500, 'tg222', 'Alice W');
    const sent = await h.sendStickerV2('group:tg-100500', 'fixture-sticker', { replyToMessageId: 9, atUserId: 'tg222' });
    const img = calls.find((c) => c.image);
    assert.equal(img.chatId, -100500);
    assert.ok(Buffer.from(img.buffer).equals(GIF), '发的是下载到的表情字节');
    assert.equal(img.opts.replyTo, 9);
    assert.deepEqual({ ...img.opts.mention }, { userId: 222, name: 'Alice W' });
    assert.equal(sent.messageId, 777);
    assert.ok(!qqHttp.some((u) => /send_(group|private)_msg/.test(u)), '不能发到 QQ');
    const info = await h.resolveReplyInfo('group', 'tg-100500', '777', 'tg7000');
    assert.match(info.text, /^\[表情包:/, '别人引用这张表情时知道是她发的表情包');
    const fetchesBefore = qqHttp.length;
    await assert.rejects(h.sendStickerV2('group:tg-100500', 'fixture-sticker', { atUserId: 'abc' }), /atUserId/, '@ 的不是 Telegram 用户 id 就拒绝');
    await assert.rejects(h.sendStickerV2('group:tg-100500', 'fixture-sticker', { atUserId: '222' }), /atUserId/, '没有 tg 前缀的数字也拒绝（多半是把 QQ 号填进来了）');
    assert.equal(calls.filter((c) => c.image).length, 1, '校验失败时不上传');
    assert.equal(qqHttp.length, fetchesBefore);
  } finally { await h.close(); }
});

await test('桥接：二代 send-sticker 接口对 Telegram 会话放行；下载到的不是图片就拒绝', async () => {
  let payload = GIF;
  const h = await bridgeHarness({ config: TG_CONFIG, globals: { safeFetchBuffer: async () => ({ buffer: payload }) } });
  try {
    const calls = fakeTelegram(h);
    h.tg.client.sendImage = async (chatId, buffer) => { calls.push({ image: true, chatId }); return { message_id: 778 }; };
    h.setMode('reserved2');
    const st = h.getSocialV2State('private:tg222');
    await withServer(h, async (port) => {
      const ok = await consoleCall(port, '/api/socialV2/send-sticker', { method: 'POST', token: st.agentToken, body: { key: 'private:tg222', stickerId: 'fixture-sticker' } });
      assert.equal(ok.status, 200, ok.body);
      assert.equal(calls.filter((c) => c.image).length, 1);
      const sendTimesBefore = st.sendTimes.length;
      const badAt = await consoleCall(port, '/api/socialV2/send-sticker', { method: 'POST', token: st.agentToken, body: { key: 'group:tg-100500', stickerId: 'fixture-sticker', atUserId: '12345' } });
      assert.equal(badAt.status, 403, '群会话不在这个令牌下');
      const stG = h.getSocialV2State('group:tg-100500');
      const gBefore = stG.sendTimes.length;
      const badAtG = await consoleCall(port, '/api/socialV2/send-sticker', { method: 'POST', token: stG.agentToken, body: { key: 'group:tg-100500', stickerId: 'fixture-sticker', atUserId: '12345' } });
      assert.equal(badAtG.status, 400, badAtG.body);
      assert.match(badAtG.json.error, /tg 开头/);
      assert.equal(stG.sendTimes.length, gBefore, '@ 不合法时不占发送额度');
      assert.equal(st.sendTimes.length, sendTimesBefore);
      payload = Buffer.from('<html>not an image</html>');
      const bad = await consoleCall(port, '/api/socialV2/send-sticker', { method: 'POST', token: st.agentToken, body: { key: 'private:tg222', stickerId: 'fixture-sticker' } });
      assert.equal(bad.status, 500);
      assert.match(bad.json.error, /不是图片/);
      const collect = await consoleCall(port, '/api/socialV2/collect-sticker', { method: 'POST', token: st.agentToken, body: { key: 'private:tg222', messageId: '1' } });
      assert.equal(collect.status, 500);
      assert.match(collect.json.error, /找不到这条消息/, '收藏默认会存进 QQ 收藏（这里消息 id 不存在）');
    });
    const prompt = h.buildWakePromptV2('private:tg222', 'private');
    assert.match(prompt, /qq_send_sticker 会以图片发出/);
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
    ownerId: 111, allow: { private: [222], groups: [-1001234567890] }, links: [], stickers: { favorites: false, syncQQ: false, copyToQQ: true }
  }, '其余 telegram 字段保留，名单去重存数字');
  const off = applyForm({ ...file, telegram: { ...file.telegram, stickers: { defaultEmoji: '😺' } } },
    { ...f, telegram: { ...f.telegram, botToken: BOT_TOKEN, stickerFavorites: false, stickerSyncQQ: false } });
  assert.deepEqual(off.file.telegram.stickers, { defaultEmoji: '😺', favorites: false, syncQQ: false, copyToQQ: true }, '贴纸开关可以关，其余贴纸配置保留');
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

// ── 6. 贴纸包（B：Telegram 收藏；C：QQ 表情同步）──────────────────────────
await test('贴纸包：包名、emoji、关键词、动图判断、贴纸引用清洗', () => {
  assert.match(TAG, /^[0-9a-f]{6}$/);
  assert.notEqual(stickerSetTag(7000, 112), TAG, '换管理员包名就变');
  assert.notEqual(stickerSetTag(7001, 111), TAG, '换 bot 包名就变');
  assert.ok(!TAG.includes('111') || TAG !== '111', '包名里不直接出现管理员 id');
  assert.deepEqual(stickerSetNames('her_bot', TAG), { fav: FAV_SET, qq: QQ_SET });
  assert.throws(() => stickerSetNames('bad__name', TAG));
  assert.throws(() => stickerSetNames('', TAG));
  assert.throws(() => stickerSetNames('her_bot', 'zz'));
  assert.deepEqual(emojiListFor(['©好 ‼']), ['©\uFE0F', '‼\uFE0F'], '文字样式的符号补上 FE0F');
  const tgDefaults = normalizeTelegramConfig({ enabled: true });
  assert.deepEqual({ ...tgDefaults.stickers, defaultEmoji: undefined }, { favorites: false, syncQQ: false, copyToQQ: true, defaultEmoji: undefined }, '贴纸包是公开的默认关；存进 QQ 收藏不公开，默认开');
  assert.deepEqual(emojiListFor(['好耶🎉 冲', '😀'], '🙂'), ['🎉', '😀']);
  assert.deepEqual(emojiListFor(['没有表情'], 'x'), ['🙂'], '默认 emoji 不是 emoji 时退回 🙂');
  assert.deepEqual(emojiListFor([''], '😺'), ['😺']);
  const kw = keywordsFor(['猫 猫猫，狗 🐶', 'a'.repeat(30), 'b'.repeat(30), 'c'.repeat(30)]);
  assert.ok(kw.join('').length <= 64 && kw.length <= 20, JSON.stringify(kw));
  assert.deepEqual(kw.slice(0, 3), ['猫', '猫猫', '狗']);
  assert.equal(isAnimatedGif(GIF), false, '单帧 GIF 当静态图');
  const twoFrames = Buffer.concat([Buffer.from('GIF89a'), Buffer.from([0x21, 0xf9, 0x04, 0, 0, 0, 0, 0, 0x21, 0xf9, 0x04])]);
  assert.equal(isAnimatedGif(twoFrames), true);
  assert.equal(isAnimatedGif(PNG), false);
  assert.deepEqual(cleanTgStickerRef({ file_id: 'CAACAgIAAxkBAAE', file_unique_id: 'AgADxx', format: 'video', emoji: '😀' }),
    { fileId: 'CAACAgIAAxkBAAE', fileUniqueId: 'AgADxx', format: 'video', emoji: '😀' });
  assert.equal(cleanTgStickerRef({ file_id: '../../etc', file_unique_id: 'AgADxx' }), null);
  assert.equal(cleanTgStickerRef({ file_id: 'CAACAgIAAxkBAAE', file_unique_id: 'AgADxx', format: 'exe', emoji: 'not emoji' }).format, 'static');
});

await test('转换（真 ffmpeg）：静态图一边 512 像素的 PNG；动图 GIF 转 ≤256 KB 的 VP9 WEBM', async () => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('  （本机没有 ffmpeg，跳过）'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-conv-'));
  try {
    const make = (name, args) => { spawnSync('ffmpeg', ['-v', 'error', '-y', ...args, path.join(tmp, name)]); return fs.readFileSync(path.join(tmp, name)); };
    const png = make('a.png', ['-f', 'lavfi', '-i', 'testsrc=size=200x100:rate=1', '-frames:v', '1']);
    const gif = make('b.gif', ['-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=20', '-t', '5']);
    const st = await convertToSticker(png, { tmpRoot: tmp });
    assert.equal(st.format, 'static');
    assert.equal(st.buffer.readUInt32BE(16), 512, '宽 512');
    assert.equal(st.buffer.readUInt32BE(20), 256, '高按比例 256');
    const vid = await convertToSticker(gif, { tmpRoot: tmp });
    assert.equal(vid.format, 'video');
    assert.ok(vid.buffer.length <= 256 * 1024, `${vid.buffer.length} 字节`);
    assert.equal(vid.buffer.readUInt32BE(0), 0x1a45dfa3, 'WEBM（EBML）文件头');
    assert.deepEqual(fs.readdirSync(tmp).filter((n) => n.startsWith('qq-bridge-tgsticker-')), [], '临时目录清理掉了');
    await assert.rejects(convertToSticker(png, { tmpRoot: tmp, ffmpeg: '/nonexistent/ffmpeg' }), /找不到 ffmpeg/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

function stickerManager(storeFile, extra = {}) {
  const converted = [];
  const m = createTgStickerManager({
    client: new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE }),
    ownerId: 111,
    me: { id: 7000, username: 'her_bot', first_name: '小鲸鱼' },
    storeFile,
    convert: async (buf) => { converted.push(buf); return { buffer: PNG, format: 'static' }; },
    gapMs: 0,
    ...extra
  });
  return { m, converted };
}

await test('B：收藏贴纸用原 file_id 进包（不重新上传），第一次自动建包；重复收藏拒绝', async () => {
  botApi.sets.clear();
  botApi.calls.length = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stk-'));
  try {
    const { m, converted } = stickerManager(path.join(tmp, 'tg.json'));
    const fav = await m.collect({ sticker: { fileId: 'CAACAgIAAxkBAAE1', fileUniqueId: 'AgAD01', format: 'video', emoji: '😹' } }, '笑死 哈哈');
    assert.equal(converted.length, 0, '贴纸不用转换');
    assert.ok(!botApi.calls.some((c) => c.method === 'uploadStickerFile'), '不用重新上传');
    const create = botApi.calls.find((c) => c.method === 'createNewStickerSet');
    assert.equal(create.params.name, FAV_SET);
    assert.equal(create.params.user_id, 111, '挂在管理员名下');
    assert.equal(create.params.title, '小鲸鱼 的收藏');
    assert.deepEqual(create.params.stickers[0], { sticker: 'CAACAgIAAxkBAAE1', format: 'video', emoji_list: ['😹'], keywords: ['笑死', '哈哈'] });
    assert.equal(fav.format, 'video');
    assert.ok(fav.fileId.startsWith('SETFILE'), '记下的是包里那张的 file_id');
    assert.ok(fav.thumbFileId, '动态贴纸记下缩略图，给模型看');
    assert.equal(fav.id, `tg:${fav.fileUniqueId}`);
    await assert.rejects(m.collect({ sticker: { fileId: 'CAACAgIAAxkBAAE1', fileUniqueId: 'AgAD01', format: 'video' } }, ''), /收藏过/);
    // 图片：转换后上传，再加进已有的包
    const fav2 = await m.collect({ image: PNG }, '');
    assert.equal(converted.length, 1);
    const up = botApi.calls.find((c) => c.method === 'uploadStickerFile');
    assert.equal(up.params.user_id, '111');
    assert.equal(up.params.sticker_format, 'static');
    assert.equal(up.params.sticker.contentType, 'image/png');
    assert.ok(botApi.calls.some((c) => c.method === 'addStickerToSet'));
    assert.deepEqual(m.favorites().map((f) => f.id), [fav.id, fav2.id]);
    assert.equal(m.findFavorite(fav2.id).emoji, '🙂', '没备注 emoji 用默认的');
    // 记录落盘，重启后还在
    const reloaded = loadTgStickerStore(path.join(tmp, 'tg.json'));
    assert.equal(reloaded.favorites.length, 2);
    assert.equal(reloaded.sets.fav.name, FAV_SET);
    assert.equal((fs.statSync(path.join(tmp, 'tg.json')).mode & 0o777), 0o600);
    // 包被人在客户端删掉后，下次收藏会重建
    botApi.sets.clear();
    const fav3 = await m.collect({ sticker: { fileId: 'CAACAgIAAxkBAAE3', fileUniqueId: 'AgAD03', format: 'static' } }, '');
    assert.ok(fav3);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await test('B：包满 120 张时拒绝并说清楚', async () => {
  botApi.sets.clear();
  botApi.sets.set(FAV_SET, { name: FAV_SET, title: 'x', stickers: Array.from({ length: SET_LIMIT }, (_, i) => ({ file_id: `F${i}xxxxxxxxxx`, file_unique_id: `U${i}` })) });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stk-'));
  try {
    const { m } = stickerManager(path.join(tmp, 'tg.json'));
    await assert.rejects(m.collect({ sticker: { fileId: 'CAACAgIAAxkBAAE9', fileUniqueId: 'AgAD09', format: 'static' } }, ''), /已满/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await test('C：QQ 表情同步——新增转换上传、QQ 里删掉的从包里删、已同步的优先保留、一次有上限', async () => {
  botApi.sets.clear();
  botApi.calls.length = 0;
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stk-'));
  const md5 = (n) => String(n).padStart(32, 'A');
  try {
    const { m, converted } = stickerManager(path.join(tmp, 'tg.json'));
    const downloads = [];
    const dl = async (e) => { downloads.push(e.md5); return GIF; };
    const lib = [{ md5: md5(1), desc: '开心😄', useCount: 1 }, { md5: md5(2), desc: '', useCount: 9 }, { md5: md5(3), localNote: '无语', useCount: 5 }, { md5: '', desc: '没 md5 的跳过' }];
    const r1 = await m.syncQq(lib, dl, { maxAdds: 2 });
    assert.deepEqual(r1, { added: 2, removed: 0, failed: 0, skipped: 1, gaveUp: 0 });
    assert.deepEqual(downloads, [md5(2), md5(3)], '用得多的先同步');
    assert.equal(converted.length, 2);
    const create = botApi.calls.find((c) => c.method === 'createNewStickerSet');
    assert.equal(create.params.name, QQ_SET);
    assert.equal(create.params.title, '小鲸鱼 的 QQ 表情');
    const r2 = await m.syncQq(lib, dl, { maxAdds: 5 });
    assert.equal(r2.added, 1, '第二轮补上剩下的');
    assert.ok(m.qqFileIdFor(md5(1).toLowerCase()), 'md5 大小写不敏感');
    const add = botApi.calls.filter((c) => c.method === 'addStickerToSet').at(-1);
    assert.deepEqual(add.params.sticker.emoji_list, ['😄'], '备注里的 emoji 当贴纸 emoji');
    // QQ 里删掉了一张
    const r3 = await m.syncQq(lib.filter((e) => e.md5 !== md5(3)), dl);
    assert.equal(r3.removed, 1);
    assert.equal(m.qqFileIdFor(md5(3)), null);
    assert.equal(botApi.sets.get(QQ_SET).stickers.length, 2);
    // 一张能认的都没有（网关没连上 / 条目缺 md5）：不动包
    const r4 = await m.syncQq([{ md5: '' }], dl);
    assert.deepEqual(r4, { added: 0, removed: 0, failed: 0, skipped: 0, gaveUp: 0 });
    assert.equal(botApi.sets.get(QQ_SET).stickers.length, 2, '空列表不能被当成全删了');
    // 包里的贴纸被人手动删了：对账时忘掉，重新上传
    botApi.sets.get(QQ_SET).stickers.length = 0;
    const r5 = await m.syncQq(lib.filter((e) => e.md5 !== md5(3)), dl);
    assert.equal(r5.added, 2, '手动删掉的重新传上去');
    // 包里多出一张本地没记录的（比如加完读包失败）：对账时删掉
    botApi.sets.get(QQ_SET).stickers.push({ file_id: 'STRAYxxxxxxxxxx', file_unique_id: 'STRAY1' });
    await m.syncQq(lib.filter((e) => e.md5 !== md5(3)), dl);
    assert.ok(!botApi.sets.get(QQ_SET).stickers.some((x) => x.file_unique_id === 'STRAY1'), '没记录的被清掉了');
    assert.equal(botApi.sets.get(QQ_SET).stickers.length, 2);
    // 同一张连续失败 3 次就不再重试
    const failing = [{ md5: md5(7) }];
    let tries = 0;
    const bad = async () => { tries += 1; throw new Error('解不了这种图'); };
    for (let i = 0; i < 3; i++) assert.equal((await m.syncQq(failing, bad)).failed, 1);
    const r6 = await m.syncQq(failing, bad);
    assert.equal(tries, 3, '第 4 轮不再尝试');
    assert.equal(r6.gaveUp, 1);
    assert.match(m.store.qqFailed[md5(7)].reason, /解不了/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await test('B：收藏包里有本地没记录的贴纸（比如记录丢了）时补记成收藏，不删', async () => {
  botApi.sets.clear();
  botApi.sets.set(FAV_SET, { name: FAV_SET, title: 'x', stickers: [{ file_id: 'OLDFAVxxxxxxxxx', file_unique_id: 'OLD1', emoji: '😺', is_animated: false, is_video: false }] });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stk-'));
  try {
    const { m } = stickerManager(path.join(tmp, 'tg.json'));
    await m.collect({ sticker: { fileId: 'CAACAgIAAxkBAAE8', fileUniqueId: 'AgAD08', format: 'static' } }, '');
    assert.deepEqual(m.favorites().map((f) => f.fileUniqueId).sort(), ['OLD1', botApi.sets.get(FAV_SET).stickers[1].file_unique_id].sort());
    assert.equal(botApi.sets.get(FAV_SET).stickers.length, 2);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await test('换了 bot 或管理员：旧记录作废，用新包名', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-stk-'));
  try {
    const file = path.join(tmp, 'tg.json');
    fs.writeFileSync(file, JSON.stringify({ binding: 'abcdef', favorites: [{ fileId: 'OLDFAVxxxxxxxxx', fileUniqueId: 'OLD1' }], qq: { ['A'.repeat(32)]: { fileId: 'OLDQQxxxxxxxxxx' } } }));
    const logs = [];
    const { m } = stickerManager(file, { log: (...a) => logs.push(a.join(' ')) });
    assert.equal(m.favorites().length, 0);
    assert.equal(m.qqFileIdFor('A'.repeat(32)), null);
    assert.equal(loadTgStickerStore(file).binding, TAG);
    assert.match(logs.join(), /bot 或 ownerId 变了/);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

await test('桥接：Telegram 会话里收藏贴纸 → 列表里看得到 → 用 tg: id 发出真贴纸', async () => {
  botApi.sets.clear();
  botApi.calls.length = 0;
  const h = await bridgeHarness({ config: TG_STICKER_CONFIG });
  try {
    h.tg.client = new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE });
    h.tg.me = { id: 7000, username: 'her_bot', first_name: '小鲸鱼' };
    h.setupTelegramStickers();
    assert.ok(h.tg.stickers, '有 ownerId 就建好贴纸包管理');
    h.setMode('reserved2');
    const r = updateToEvent(msgUpdate({
      chat: privChat, from: { id: 111, first_name: '主人' }, message_id: 31,
      sticker: { file_id: 'CAACAgIAAxkBAAE5', file_unique_id: 'AgAD05', is_animated: true, is_video: false, emoji: '🐱', thumbnail: { file_id: 'THUMBxxxxxxxxxx' } }
    }), h.tg.me, { cache: h.tg.cache, now: NOW * 1000 });
    assert.equal(r.event.message[0].data.file, 'tgfile:THUMBxxxxxxxxxx', '动态贴纸给模型看缩略图');
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    const st = h.getSocialV2State('private:tg111');
    const msg = st.recentMessages.find((x) => String(x.messageId) === '31');
    assert.equal(msg.media[0].tgSticker.fileId, 'CAACAgIAAxkBAAE5', '收藏用的贴纸信息存下来了');
    await withServer(h, async (port) => {
      const collect = await consoleCall(port, '/api/socialV2/collect-sticker', { method: 'POST', token: st.agentToken, body: { key: 'private:tg111', messageId: '31', remark: '猫猫' } });
      assert.equal(collect.status, 200, collect.body);
      assert.match(collect.json.emojiId, /^tg:/);
      assert.equal(botApi.sets.get(FAV_SET).stickers[0].source, 'CAACAgIAAxkBAAE5');
      const list = await consoleCall(port, '/api/socialV2/sticker-list', { method: 'POST', token: st.agentToken, body: { key: 'private:tg111' } });
      assert.equal(list.status, 200, list.body);
      assert.equal(list.json.telegramFavorites.length, 1);
      assert.equal(list.json.telegramFavorites[0].note, '猫猫');
      const favId = list.json.telegramFavorites[0].id;
      const note = await consoleCall(port, '/api/socialV2/sticker-note', { method: 'POST', token: st.agentToken, body: { key: 'private:tg111', stickerId: favId, note: '猫猫叹气' } });
      assert.equal(note.status, 200, note.body);
      const tagsOnly = await consoleCall(port, '/api/socialV2/sticker-note', { method: 'POST', token: st.agentToken, body: { key: 'private:tg111', stickerId: favId, tags: ['猫'] } });
      assert.equal(tagsOnly.status, 400, '只传 tags 时不能把备注清空');
      assert.equal(h.tg.stickers.findFavorite(favId).note, '猫猫叹气');
      const img = await consoleCall(port, `/api/socialV2/sticker-image?key=private%3Atg111&stickerId=${encodeURIComponent(favId)}`, { token: st.agentToken });
      assert.equal(img.status, 200, img.body);
      assert.equal(img.json.image.mimeType, 'image/png', '动态贴纸看缩略图');
      botApi.calls.length = 0;
      const send = await consoleCall(port, '/api/socialV2/send-sticker', { method: 'POST', token: st.agentToken, body: { key: 'private:tg111', stickerId: favId, replyToMessageId: 31 } });
      assert.equal(send.status, 200, send.body);
      const call = botApi.calls.find((c) => c.method === 'sendSticker');
      assert.equal(call.params.sticker, botApi.sets.get(FAV_SET).stickers[0].file_id, '发的是包里那张');
      assert.equal(call.params.reply_parameters.message_id, 31);
      assert.ok(!botApi.calls.some((c) => c.method === 'sendPhoto'), '不是发图片');
      const withAt = await consoleCall(port, '/api/socialV2/send-sticker', { method: 'POST', token: h.getSocialV2State('group:tg-100500').agentToken, body: { key: 'group:tg-100500', stickerId: favId, atUserId: 'tg222' } });
      assert.equal(withAt.status, 500);
      assert.match(withAt.json.error, /不能带 @/);
      // 别人的消息可以收藏，自己发的不行；QQ 会话的收藏不受影响（仍走 QQ）
      const self = await consoleCall(port, '/api/socialV2/collect-sticker', { method: 'POST', token: st.agentToken, body: { key: 'private:tg111', messageId: '999' } });
      assert.equal(self.status, 500);
      assert.match(self.json.error, /找不到这条消息/);
    });
    const prompt = h.buildWakePromptV2('private:tg111', 'private');
    assert.match(prompt, /你在 Telegram 收藏了 1 张贴纸/);
    assert.match(prompt, /qq_collect_sticker 收藏，会存进你的 Telegram 贴纸包，并存一份到QQ 收藏表情/);
  } finally { await h.close(); }
});

await test('桥接：同步过的 QQ 表情发成真贴纸；贴纸发送失败退回发图；QQ 表情库为空时不动贴纸包', async () => {
  const qqHttp = [];
  const h = await bridgeHarness({ config: TG_STICKER_CONFIG, globals: {
    safeFetchBuffer: async () => ({ buffer: GIF }),
    fetch: async (url) => { qqHttp.push(String(url)); return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) }; }
  } });
  try {
    const calls = fakeTelegram(h);
    h.tg.client.sendImage = async (chatId, buffer, opts) => { calls.push({ image: true, chatId }); return { message_id: 801 }; };
    let stickerFails = false;
    h.tg.client.sendSticker = async (chatId, fileId, opts) => {
      if (stickerFails === 'timeout') throw new Error('Telegram sendSticker 网络错误：请求超时（8000ms）');
      if (stickerFails) throw Object.assign(new Error('Telegram sendSticker 失败：Bad Request: wrong file identifier'), { code: 400 });
      calls.push({ sticker: fileId, chatId, opts }); return { message_id: 802 };
    };
    h.tg.stickers = { qqFileIdFor: () => 'SYNCEDFILExxxxxxx', favorites: () => [], findFavorite: () => null, syncQq: async () => { throw new Error('不该被调用'); } };
    const sent = await h.sendStickerV2('private:tg222', 'fixture-sticker');
    assert.equal(sent.messageId, 802);
    assert.deepEqual(calls.filter((c) => c.sticker).map((c) => c.sticker), ['SYNCEDFILExxxxxxx']);
    assert.equal(calls.filter((c) => c.image).length, 0);
    stickerFails = true;
    const fallback = await h.sendStickerV2('private:tg222', 'fixture-sticker');
    assert.equal(fallback.messageId, 801, 'Telegram 明确拒绝贴纸时改发图片');
    stickerFails = 'timeout';
    const imagesBefore = calls.filter((c) => c.image).length;
    await assert.rejects(h.sendStickerV2('private:tg222', 'fixture-sticker'), /超时/);
    assert.equal(calls.filter((c) => c.image).length, imagesBefore, '超时不改发图片（贴纸可能已经到了，再发就成两条）');
    // 要 @ 人时贴纸带不了说明，直接发图片
    stickerFails = false;
    await h.sendStickerV2('group:tg-100500', 'fixture-sticker', { atUserId: 'tg222' });
    assert.equal(calls.filter((c) => c.image).length, 2);
    assert.ok(!qqHttp.some((u) => /send_(group|private)_msg/.test(u)), '全程没发到 QQ');
    // 测试脚手架里的 QQ 表情没有 md5，同步时都被跳过；表情库空时直接不动包
    h.cfg.telegram.stickers.syncQQ = true;
    assert.equal(await h.runQqStickerSync(), null, '没有可同步的就什么都不做（尤其不能把包删空）');
  } finally { await h.close(); }
});

await test('桥接：贴纸包默认关闭（公开的），不打开就不建', async () => {
  const h = await bridgeHarness({ config: TG_CONFIG });
  try {
    fakeTelegram(h);
    h.setupTelegramStickers();
    assert.equal(h.tg.stickers, null);
    assert.match(h.buildWakePromptV2('private:tg111', 'private'), /qq_collect_sticker 收藏，会存进QQ 收藏表情/, '默认只存 QQ 收藏');
    h.cfg.telegram.stickers.copyToQQ = false;
    assert.ok(!/qq_collect_sticker/.test(h.buildWakePromptV2('private:tg111', 'private')), '两个去处都关着就不提收藏');
    // QQ 会话：收藏开着时照常提，管理端关掉收藏后也不提
    assert.match(h.buildWakePromptV2('private:222', 'private'), /qq_collect_sticker/);
    h.cfg.socialV2.sticker = { ...(h.cfg.socialV2.sticker ?? {}), collect: { enabled: false } };
    assert.ok(!/qq_collect_sticker/.test(h.buildWakePromptV2('private:222', 'private')), '收藏关了就不提收藏');
  } finally { await h.close(); }
});

await test('桥接：没配 ownerId 时不建贴纸包，表情照样以图片发', async () => {
  const h = await bridgeHarness({ config: { telegram: { ...TG_STICKER_CONFIG.telegram, ownerId: null } } });
  try {
    fakeTelegram(h);
    h.setupTelegramStickers();
    assert.equal(h.tg.stickers, null);
  } finally { await h.close(); }
});

// ── 7. 同一个人（QQ 私聊 ↔ Telegram 私聊并成一个会话）────────────────────────
await test('同一个人：配置规范化（格式、重复、prefer）', () => {
  const { links, invalid } = normalizeTelegramLinks([
    { qq: 10001, telegram: 222 },
    { qq: '10002', telegram: '333', prefer: 'telegram' },
    { qq: 10003, telegram: 222 },
    { qq: 10001, telegram: 444 },
    { qq: 'abc', telegram: 5 },
    { qq: 10005, telegram: -100 }
  ]);
  assert.deepEqual(links, [{ qq: 10001, telegram: 222, prefer: 'last' }, { qq: 10002, telegram: 333, prefer: 'telegram' }]);
  assert.equal(invalid.length, 4);
  assert.deepEqual(telegramConfigProblems({ ...normalizeTelegramConfig({ botToken: BOT_TOKEN, links: [{ qq: 'x' }] }) }), [], '写错的组只警告，不让整个 Telegram 停掉');
});

const LINK_CONFIG = {
  allow: { private: ['123', '10001'], groups: ['456'] },
  telegram: { ...TG_CONFIG.telegram, allow: { private: [222], groups: [-100500] }, links: [{ qq: 10001, telegram: 222 }] }
};
const qqEvent = (text, messageId) => ({ post_type: 'message', message_type: 'private', user_id: 10001, self_id: 999, message_id: messageId, sender: { user_id: 10001, nickname: '小明' }, message: [{ type: 'text', data: { text } }] });
const tgEventFor = (h, text, messageId) => updateToEvent(msgUpdate({ chat: { id: 222, type: 'private' }, from: { id: 222, first_name: 'Alice' }, text, message_id: messageId }), h.tg.me, { cache: h.tg.cache, now: NOW * 1000 });

await test('同一个人：Telegram 私聊并进 QQ 主会话，回复发到 TA 最后说话的平台', async () => {
  const h = await bridgeHarness({ config: LINK_CONFIG, files: { 'state/social-v2.json': { conversations: { 'private:tg222': { agentToken: 'b'.repeat(32) } } } } });
  try {
    const calls = fakeTelegram(h);
    h.setMode('reserved2');
    assert.ok(!h.socialV2.conversations.has('private:tg222'), '并进来的 Telegram 私聊原来的二代状态不再使用');
    const r = tgEventFor(h, '在吗', 41);
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    const st = h.getSocialV2State('private:10001');
    assert.ok(st.unread.some((m) => m.text === '[Telegram] 在吗'), JSON.stringify(st.unread.map((m) => m.text)));
    assert.equal(h.getSocialV2State('private:tg222'), st, '别名拿到的是同一份状态');
    assert.equal(h.resolveDeliveryKey('private:10001'), 'private:tg222');
    assert.match(h.buildWakePromptV2('private:10001', 'private'), /【同一个人】.*最近一条来自 Telegram.*送到 Telegram/);
    await withServer(h, async (port) => {
      // 她用主会话 key 发：送到 Telegram
      const a = await consoleCall(port, '/api/socialV2/send-message', { method: 'POST', token: st.agentToken, body: { key: 'private:10001', messages: ['在呀'] } });
      assert.equal(a.status, 200, a.body);
      assert.deepEqual(calls.filter((c) => c.text).map((c) => [c.chatId, c.text]), [[222, '在呀']]);
      // 用 Telegram 别名 key + 同一个令牌也行
      const b = await consoleCall(port, '/api/socialV2/send-message', { method: 'POST', token: st.agentToken, body: { key: 'private:tg222', messages: ['嗯'] } });
      assert.equal(b.status, 200, b.body);
      // TA 换到 QQ 说话 → 回复发 QQ；引用 Telegram 那条消息时去掉引用
      await h.handleIncoming('private', 10001, qqEvent('我在 QQ', 9001), h.cfg);
      assert.ok(st.unread.some((m) => m.text === '[QQ] 我在 QQ'));
      h.calls.http.length = 0;
      const c = await consoleCall(port, '/api/send/private', { method: 'POST', token: st.agentToken, body: { userId: '10001', message: '看到了', replyToMessageId: 41, token: st.agentToken } });
      assert.equal(c.status, 200, c.body);
      const qqSend = h.calls.http.find((x) => x.url.endsWith('/send_private_msg'));
      assert.equal(qqSend.body.user_id, 10001, '发到 QQ');
      assert.ok(!qqSend.body.message.some((seg) => seg.type === 'reply'), '跨平台的引用去掉');
      h.calls.http.length = 0;
      // 脚手架里的假 QQ 网关不支持按 id 查消息，用 seq 引用（桥接会映射回真实的 9001）
      const qqSeq = st.recentMessages.find((m) => m.messageId === '9001').seq;
      const d = await consoleCall(port, '/api/send/private', { method: 'POST', token: st.agentToken, body: { userId: '10001', message: '回你', replyToMessageId: qqSeq, token: st.agentToken } });
      assert.equal(d.status, 200, d.body);
      assert.ok(h.calls.http.find((x) => x.url.endsWith('/send_private_msg')).body.message.some((seg) => seg.type === 'reply'), '同平台的引用保留');
    });
    assert.equal(calls.filter((c) => c.text).length, 2, '换到 QQ 后不再发 Telegram');
  } finally { await h.close(); }
});

await test('同一个人：两边白名单各管各的；Telegram 没连上或指定了平台时按规则选', async () => {
  const h = await bridgeHarness({ config: LINK_CONFIG });
  try {
    const calls = fakeTelegram(h);
    h.setMode('chat');
    // 一代模式也并会话：DSH 会话建在主会话上
    const r = tgEventFor(h, '你好', 42);
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    assert.ok(h.state.sessions['private:10001'], 'DSH 会话记在主会话上');
    assert.ok(!h.state.sessions['private:tg222']);
    assert.match(JSON.stringify(h.calls.prompts.at(-1).content), /\[Telegram\] 你好/);
    assert.equal(h.state.linkRoutes['private:10001'], 'private:tg222', '记下最后从哪边来（会持久化）');
    // Telegram 没连上：发 QQ
    const me = h.tg.me;
    h.tg.me = null;
    assert.equal(h.resolveDeliveryKey('private:10001'), 'private:10001');
    h.tg.me = me;
    // Telegram 那边不在白名单：Telegram 来的消息不收，发也只发 QQ
    h.cfg.telegram.allow.private = [];
    const before = h.calls.prompts.length;
    await h.handleIncoming(r.kind, r.id, tgEventFor(h, '再来', 43).event, h.cfg);
    assert.equal(h.calls.prompts.length, before, 'Telegram 不放行就不收');
    assert.equal(h.resolveDeliveryKey('private:10001'), 'private:10001', '也不往 Telegram 发');
    // QQ 那边不在白名单、Telegram 在：QQ 来的不收，会话照样可用，发到 Telegram
    h.cfg.telegram.allow.private = [222];
    h.cfg.allow.private = ['123'];
    await h.handleIncoming('private', 10001, qqEvent('qq 来的', 9002), h.cfg);
    assert.equal(h.calls.prompts.length, before, 'QQ 不放行就不收');
    assert.equal(h.isSessionAllowedInCurrentMode('private:10001'), true, '有一边放行，会话就还在');
    assert.equal(h.resolveDeliveryKey('private:10001'), 'private:tg222');
    await h.sendToQQ('private:10001', '只能发 Telegram');
    assert.equal(calls.filter((c) => c.text).at(-1).text, '只能发 Telegram');
    // 没合并的会话不受影响
    assert.equal(h.resolveDeliveryKey('private:123'), 'private:123');
    assert.equal(h.resolveDeliveryKey('group:456'), 'group:456');
  } finally { await h.close(); }
});

await test('同一个人：配置页按行读写，保留 prefer，格式错和重复都拦下', () => {
  const file = { ownerQQ: 10001, allow: {}, telegram: { botToken: BOT_TOKEN, links: [{ qq: 10001, telegram: 222, prefer: 'telegram' }] } };
  const f = toForm(file);
  assert.deepEqual(f.telegram.links, ['10001 = 222']);
  const ok = applyForm(file, { ...f, telegram: { ...f.telegram, links: ['10001 = 222', '10002：333', ''] } });
  assert.ok(!ok.errors, JSON.stringify(ok.errors));
  assert.deepEqual(ok.file.telegram.links, [{ qq: 10001, telegram: 222, prefer: 'telegram' }, { qq: 10002, telegram: 333 }]);
  const bad = applyForm(file, { ...f, telegram: { ...f.telegram, links: ['abc', '10001 = 222', '10001 = 444', '10003 = -5'] } });
  assert.equal(bad.errors.length, 3, JSON.stringify(bad.errors));
});

await test('同一个人：QQ 那边没放行时，拍一拍 / 语音 / 兜底发送都不会发到 QQ', async () => {
  const cfg = { ...LINK_CONFIG, deny: { private: ['10001'] } };
  const h = await bridgeHarness({ config: cfg });
  try {
    const calls = fakeTelegram(h);
    h.setMode('reserved2');
    const r = tgEventFor(h, 'hi', 51);
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    const st = h.getSocialV2State('private:10001');
    await withServer(h, async (port) => {
      const poke = await consoleCall(port, '/api/socialV2/send-poke', { method: 'POST', token: st.agentToken, body: { key: 'private:10001' } });
      assert.equal(poke.status, 403, `拍一拍只看 QQ 白名单：${poke.body}`);
    });
    await assert.rejects(h.sendVoiceV2('private:tg222', '/nonexistent.mp3'), /QQ 那边没有放行/);
    // Telegram 没连上：两边都发不了，绝不退回 QQ
    h.tg.me = null;
    assert.equal(h.resolveDeliveryKey('private:10001'), null);
    await h.sendToQQ('private:10001', '不该发出去');
    assert.equal(h.calls.sent.length, 0, '没发到 QQ');
    await withServer(h, async (port) => {
      const res = await consoleCall(port, '/api/socialV2/send-message', { method: 'POST', token: st.agentToken, body: { key: 'private:10001', messages: ['x'] } });
      assert.equal(res.status, 500);
      assert.match(res.json.error, /两边的平台现在都发不了/);
    });
    assert.ok(!h.calls.http.some((x) => /send_private_msg/.test(x.url)));
    assert.equal(calls.filter((c) => c.text).length, 0);
  } finally { await h.close(); }
});

await test('同一个人：一组消息发到一半撤掉那边的白名单，剩下的不再发', async () => {
  const h = await bridgeHarness({ config: LINK_CONFIG });
  try {
    const calls = fakeTelegram(h);
    h.setMode('chat');
    const r = tgEventFor(h, 'hi', 52);
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    const done = h.sendBurstToQQ('private:10001', ['第一条', '第二条'], 300, 300);
    await sleep(100);
    h.cfg.telegram.allow.private = [];
    await done;
    assert.deepEqual(calls.filter((c) => c.text && c.text !== h.cfg.ackMessage).map((c) => c.text), ['第一条']);
    assert.equal(h.calls.sent.length, 0, '也不改发到 QQ（发送平台在排队时就定了）');
  } finally { await h.close(); }
});

await test('同一个人：合并掉的 Telegram 私聊旧状态先备份；消息记下来源平台（重启后引用判断还在）', async () => {
  const h = await bridgeHarness({ config: LINK_CONFIG, files: { 'state/social-v2.json': { conversations: { 'private:tg222': { agentToken: 'c'.repeat(32), recentMessages: [{ seq: 1, text: '旧消息' }] } } } } });
  try {
    fakeTelegram(h);
    const backup = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/social-v2.linked-backup.json'), 'utf8'));
    assert.equal(backup['private:tg222'].recentMessages[0].text, '旧消息');
    assert.equal((fs.statSync(path.join(h.temp, 'state/social-v2.linked-backup.json')).mode & 0o777), 0o600);
    h.setMode('reserved2');
    const r = tgEventFor(h, 'hi', 53);
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    await h.handleIncoming('private', 10001, qqEvent('qq', 53), h.cfg);
    const st = h.getSocialV2State('private:10001');
    assert.deepEqual([...st.recentMessages.filter((m) => m.messageId === '53').map((m) => m.via)].sort(), ['qq', 'telegram'], '两边 id 撞了也分得清来源');
  } finally { await h.close(); }
});

await test('同一个人：合并的私聊里收藏 Telegram 贴纸进 Telegram 贴纸包', async () => {
  botApi.sets.clear();
  const h = await bridgeHarness({ config: { ...LINK_CONFIG, telegram: { ...LINK_CONFIG.telegram, ownerId: 111, stickers: { favorites: true } } } });
  try {
    h.tg.client = new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE });
    h.tg.me = { id: 7000, username: 'her_bot', first_name: '小鲸鱼' };
    h.setupTelegramStickers();
    h.setMode('reserved2');
    const r = updateToEvent(msgUpdate({ chat: { id: 222, type: 'private' }, from: { id: 222, first_name: 'Alice' }, message_id: 61,
      sticker: { file_id: 'CAACAgIAAxkBAAF1', file_unique_id: 'AgAD61', is_animated: false, is_video: false, emoji: '🐶' } }), h.tg.me, { cache: h.tg.cache, now: NOW * 1000 });
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    const st = h.getSocialV2State('private:10001');
    await withServer(h, async (port) => {
      const res = await consoleCall(port, '/api/socialV2/collect-sticker', { method: 'POST', token: st.agentToken, body: { key: 'private:10001', messageId: '61' } });
      assert.equal(res.status, 200, res.body);
      assert.match(res.json.emojiId, /^tg:/, '进的是 Telegram 贴纸包');
      const list = await consoleCall(port, '/api/socialV2/sticker-list', { method: 'POST', token: st.agentToken, body: { key: 'private:10001' } });
      assert.equal(list.json.telegramFavorites.length, 1, '会发到 Telegram 时列出 Telegram 收藏');
    });
  } finally { await h.close(); }
});

function qqFaceRecorder(h, { impl = 'SnowLuma' } = {}) {
  const faces = [];
  const md5s = [];
  h.bot.request = async (action, params) => {
    if (action === 'add_custom_face') {
      const bytes = String(params.file).startsWith('base64://') ? Buffer.from(params.file.slice(9), 'base64') : fs.readFileSync(params.file);
      faces.push(params.file);
      md5s.push(crypto.createHash('md5').update(bytes).digest('hex').toUpperCase());
      return { status: 'ok', retcode: 0, data: impl === 'NapCat.Onebot' ? {} : { emoji_id: `E${faces.length}` } };
    }
    if (action === 'get_version_info') return { status: 'ok', retcode: 0, data: { app_name: impl } };
    if (action === 'fetch_custom_face_detail') return { status: 'ok', retcode: 0, data: md5s.map((m, i) => ({ emoji_id: `E${i + 1}`, md5: m, url: `https://public.invalid/${i}` })) };
    return { status: 'ok', retcode: 0, data: {} };
  };
  faces.md5s = md5s;
  return faces;
}

await test('Telegram 上收藏 → 同时存进 QQ 收藏：图片原样存、静态贴纸 / 动画贴纸存图、只开 QQ 时不需要贴纸包', async () => {
  const h = await bridgeHarness({ config: TG_CONFIG });
  try {
    const faces = qqFaceRecorder(h);
    h.tg.client = new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE });
    h.tg.me = { id: 7000, username: 'her_bot', first_name: '小鲸鱼' };
    h.setMode('reserved2');
    const send = async (message) => {
      const r = updateToEvent(msgUpdate({ chat: { id: 222, type: 'private' }, from: { id: 222, first_name: 'Alice' }, ...message }), h.tg.me, { cache: h.tg.cache, now: NOW * 1000 });
      await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    };
    await send({ message_id: 71, photo: [{ file_id: 'PHOTOxxxxxxxx', file_size: 100 }] });
    await send({ message_id: 72, sticker: { file_id: 'CAACAgIAAxkBAAF7', file_unique_id: 'AgAD72', is_animated: true, is_video: false, emoji: '🐱', thumbnail: { file_id: 'THUMB72xxxxxxxx' } } });
    const st = h.getSocialV2State('private:tg222');
    await withServer(h, async (port) => {
      for (const id of ['71', '72']) {
        const res = await consoleCall(port, '/api/socialV2/collect-sticker', { method: 'POST', token: st.agentToken, body: { key: 'private:tg222', messageId: id, remark: '好玩' } });
        assert.equal(res.status, 200, res.body);
        assert.equal(res.json.savedTo.qq.ok, true);
        assert.equal(res.json.savedTo.telegram, null, '贴纸包没开就不去');
      }
    });
    assert.equal(faces.length, 2);
    assert.ok(faces.every((f) => Buffer.from(f.replace('base64://', ''), 'base64').subarray(1, 4).toString() === 'PNG'), '存进 QQ 的是 PNG 图片');
    assert.ok(botApi.calls.some((c) => c.method === 'getFile' && c.params.file_id === 'THUMB72xxxxxxxx'), '动画贴纸存的是缩略图');
  } finally { await h.close(); }
});

await test('Telegram 上收藏视频贴纸 → QQ 收藏里是 GIF（真 ffmpeg）；只成功一边时说明另一边为什么失败', async () => {
  if (spawnSync('ffmpeg', ['-version']).status !== 0) { console.log('  （本机没有 ffmpeg，跳过）'); return; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tg-qq-'));
  spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x240:rate=20', '-t', '2', path.join(tmp, 'b.gif')]);
  const webm = (await convertToSticker(fs.readFileSync(path.join(tmp, 'b.gif')), { tmpRoot: tmp })).buffer;
  const h = await bridgeHarness({ config: { telegram: { ...TG_CONFIG.telegram, stickers: { favorites: true } } } });
  try {
    const faces = qqFaceRecorder(h);
    const downloads = [];
    h.tg.client = { downloadFile: async (id) => { downloads.push(id); return id === 'CAACAgIAAxkBAAF8' ? webm : PNG; }, redact: (x) => x };
    h.tg.me = { id: 7000, username: 'her_bot', first_name: '小鲸鱼' };
    h.setMode('reserved2');
    const r = updateToEvent(msgUpdate({ chat: { id: 222, type: 'private' }, from: { id: 222, first_name: 'Alice' }, message_id: 73,
      sticker: { file_id: 'CAACAgIAAxkBAAF8', file_unique_id: 'AgAD73', is_animated: false, is_video: true, emoji: '🎉', thumbnail: { file_id: 'THUMB73xxxxxxxx' } } }), h.tg.me, { cache: h.tg.cache, now: NOW * 1000 });
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    const st = h.getSocialV2State('private:tg222');
    await withServer(h, async (port) => {
      const res = await consoleCall(port, '/api/socialV2/collect-sticker', { method: 'POST', token: st.agentToken, body: { key: 'private:tg222', messageId: '73' } });
      assert.equal(res.status, 200, res.body);
      assert.equal(res.json.savedTo.telegram.ok, false, '贴纸包没准备好（这里没配管理器）');
      assert.match(res.json.savedTo.telegram.error, /没准备好/);
      assert.equal(res.json.savedTo.qq.ok, true);
    });
    assert.ok(downloads.includes('CAACAgIAAxkBAAF8'), '视频贴纸下载的是贴纸本身，不是缩略图');
    const gif = Buffer.from(faces[0].replace('base64://', ''), 'base64');
    assert.equal(gif.subarray(0, 6).toString(), 'GIF89a', 'QQ 收藏里是 GIF');
    assert.ok(isAnimatedGif(gif), '而且会动');
  } finally {
    await h.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

await test('Telegram 收藏过来的 QQ 表情不再被「QQ 表情同步」传回 Telegram；NapCat 临时文件放在随机私有目录', async () => {
  const h = await bridgeHarness({ config: { telegram: { ...TG_CONFIG.telegram, stickers: { syncQQ: true } } } });
  try {
    const faces = qqFaceRecorder(h, { impl: 'NapCat.Onebot' });
    faces.md5s.push('B'.repeat(32)); // QQ 里本来就有的一张
    h.tg.client = new TelegramClient({ botToken: BOT_TOKEN, apiBase: API_BASE });
    h.tg.me = { id: 7000, username: 'her_bot', first_name: '小鲸鱼' };
    h.setMode('reserved2');
    const r = updateToEvent(msgUpdate({ chat: { id: 222, type: 'private' }, from: { id: 222, first_name: 'Alice' }, message_id: 81, photo: [{ file_id: 'PHOTO81xxxxxxxx', file_size: 100 }] }), h.tg.me, { cache: h.tg.cache, now: NOW * 1000 });
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    const res = await h.collectTelegramStickerV2('private:tg222', '81', '');
    assert.equal(res.qq.ok, true);
    const napcatPath = faces[0];
    assert.ok(napcatPath.startsWith(os.tmpdir()) || napcatPath.startsWith(fs.realpathSync(os.tmpdir())), napcatPath);
    assert.match(path.basename(path.dirname(napcatPath)), /^qq-bridge-faces-\w{6}$/, '随机名字的私有目录');
    assert.ok(!fs.existsSync(path.dirname(napcatPath)), '用完就删');
    let seen = null;
    h.tg.stickers = { syncQq: async (entries) => { seen = entries; return { added: 0, removed: 0, failed: 0, skipped: 0, gaveUp: 0 }; } };
    await h.runQqStickerSync();
    assert.ok(seen, '同步跑了');
    assert.deepEqual([...seen.map((e) => e.md5)], ['B'.repeat(32)], 'Telegram 来的那张被跳过，QQ 原有的照常同步');
  } finally { await h.close(); }
});

await test('视频贴纸转不了 GIF（比如 ffmpeg 没带 libvpx）时改存缩略图', async () => {
  const h = await bridgeHarness({ config: TG_CONFIG });
  try {
    const faces = qqFaceRecorder(h);
    const downloads = [];
    h.tg.client = { downloadFile: async (id) => { downloads.push(id); return id === 'CAACAgIAAxkBAAF9' ? Buffer.from('not a webm at all') : PNG; }, redact: (x) => x };
    h.tg.me = { id: 7000, username: 'her_bot', first_name: '小鲸鱼' };
    h.setMode('reserved2');
    const r = updateToEvent(msgUpdate({ chat: { id: 222, type: 'private' }, from: { id: 222, first_name: 'Alice' }, message_id: 82,
      sticker: { file_id: 'CAACAgIAAxkBAAF9', file_unique_id: 'AgAD82', is_video: true, is_animated: false, emoji: '🙃', thumbnail: { file_id: 'THUMB82xxxxxxxx' } } }), h.tg.me, { cache: h.tg.cache, now: NOW * 1000 });
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    const res = await h.collectTelegramStickerV2('private:tg222', '82', '');
    assert.equal(res.qq.ok, true, JSON.stringify(res));
    assert.deepEqual(downloads, ['CAACAgIAAxkBAAF9', 'THUMB82xxxxxxxx']);
    assert.equal(Buffer.from(faces[0].replace('base64://', ''), 'base64').subarray(1, 4).toString(), 'PNG');
  } finally { await h.close(); }
});

await test('Telegram 上收藏：两个去处都关着时直接说明', async () => {
  const h = await bridgeHarness({ config: { telegram: { ...TG_CONFIG.telegram, stickers: { favorites: false, copyToQQ: false } } } });
  try {
    fakeTelegram(h);
    await assert.rejects(h.collectTelegramStickerV2('private:tg222', '1', ''), /都关着/);
  } finally { await h.close(); }
});

await test('同一个人：prefer 指定平台', async () => {
  const h = await bridgeHarness({ config: { ...LINK_CONFIG, telegram: { ...LINK_CONFIG.telegram, links: [{ qq: 10001, telegram: 222, prefer: 'qq' }] } } });
  try {
    fakeTelegram(h);
    h.setMode('chat');
    const r = tgEventFor(h, '你好', 44);
    await h.handleIncoming(r.kind, r.id, r.event, h.cfg);
    assert.equal(h.resolveDeliveryKey('private:10001'), 'private:10001', 'prefer=qq 时 TA 在 Telegram 说话也回 QQ');
  } finally { await h.close(); }
});

apiServer.close();
proxy.close();
console.log(failures ? `\n${failures} 项失败` : '\n全部通过');
process.exit(failures ? 1 : 0);
