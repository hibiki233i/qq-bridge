// Telegram Bot 接入：把 Telegram 消息转成桥接认识的 OneBot 形状事件，并负责往 Telegram 发文字。
//
// 会话 id 约定：Telegram 会话写成 `tg<chat_id>`，key 形如 `private:tg123456789`、
// `group:tg-1001234567890`（群的 chat_id 是负数）。这样它和 QQ 号永远不会撞车，
// 而 `key.split(':')` 这类老代码仍然能拆出 kind / id 两段。
//
// 收消息用 getUpdates 长轮询：不需要公网地址，也不需要 webhook。
// 只依赖 Node 内置模块；走代理时自己发 HTTP CONNECT 打隧道（国内直连 api.telegram.org 不通）。
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import crypto from 'node:crypto';
import { sniffImageExt } from './onebot-impl.js';

const TG_CONV_ID_RE = /^tg(-?\d+)$/;
const BOT_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;
const DEFAULT_API_BASE = 'https://api.telegram.org';
const MAX_JSON_BYTES = 4 * 1024 * 1024;
// Telegram 单条消息上限 4096 个字符；留一点余量。
const MAX_TEXT_CHARS = 4000;
// 发送的单次请求超时，以及被限流时原地重试愿意等的最长时间。两者加起来要小于桥接的发送超时（15 秒），
// 否则桥接已经判定「发送失败」、重试却还在后台发出去，模型再发一遍就成了重复消息。
const SEND_TIMEOUT_MS = 8000;
const MAX_INLINE_RETRY_SEC = 3;
// 上传图片比发文字慢，单独给 20 秒；桥接那边对上传另包一层 25 秒超时（见 bridge.js 的 sendStickerV2）。
// 上传被限流时不原地重试：重试会让总耗时超过外层超时。
const UPLOAD_TIMEOUT_MS = 20000;

/** `tg<chat_id>` 形式的会话 id。 */
export function tgConvId(chatId) {
  return `tg${chatId}`;
}

/** 从会话 id 取回 Telegram chat_id；不是 Telegram 会话（或格式不对）返回 null。 */
export function tgChatIdOf(convId) {
  const m = TG_CONV_ID_RE.exec(String(convId ?? '').trim());
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isSafeInteger(n) && n !== 0 ? n : null;
}

export function isTelegramConvId(convId) {
  return tgChatIdOf(convId) !== null;
}

function toTgId(value, { allowNegative }) {
  const s = String(value ?? '').trim();
  if (!/^-?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n === 0) return null;
  if (n < 0 && !allowNegative) return null;
  return n;
}

function normalizeTgIdList(value, opts) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const v of value) {
    const n = toTgId(v, opts);
    if (n !== null && !out.includes(n)) out.push(n);
  }
  return out;
}

/**
 * config.json 的 `telegram` 段规范化。
 *
 * 白名单与 QQ 的 allow 分开存：Telegram 的群 id 是负数，而 QQ 那套校验只认正整数。
 * Telegram 不跟随 `allowAllWhenEmpty` —— bot 谁都能搜到、谁都能私聊，名单为空就是谁也不理。
 */
export function normalizeTelegramConfig(raw) {
  const t = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const ownerRaw = t.ownerId;
  let ownerId = null;
  let invalidOwnerId = '';
  // 写错了不抛错：抛错会让整个桥接起不来，连 QQ 一起停。只记下来，由 telegramConfigProblems 拦住 Telegram。
  if (ownerRaw !== undefined && ownerRaw !== null && String(ownerRaw).trim() !== '') {
    ownerId = toTgId(ownerRaw, { allowNegative: false });
    if (ownerId === null) invalidOwnerId = String(ownerRaw).trim().slice(0, 40);
  }
  const pollTimeoutSec = Math.min(50, Math.max(1, Math.floor(Number(t.pollTimeoutSec) || 30)));
  return {
    enabled: t.enabled === true,
    botToken: String(t.botToken ?? '').trim(),
    proxy: String(t.proxy ?? '').trim(),
    apiBase: String(t.apiBase || DEFAULT_API_BASE).trim().replace(/\/+$/, ''),
    ownerId,
    invalidOwnerId,
    allow: {
      private: normalizeTgIdList(t.allow?.private, { allowNegative: false }),
      groups: normalizeTgIdList(t.allow?.groups, { allowNegative: true })
    },
    pollTimeoutSec,
    // 贴纸包（要 ownerId）：favorites = 她在 Telegram 上收藏贴纸；syncQQ = 把 QQ 收藏表情同步成贴纸包。
    // 贴纸包是公开的（知道包名就能打开），所以默认都关，要管理员明确打开。
    stickers: {
      favorites: t.stickers?.favorites === true,
      syncQQ: t.stickers?.syncQQ === true,
      defaultEmoji: String(t.stickers?.defaultEmoji ?? '🙂').slice(0, 16) || '🙂'
    }
  };
}

/** 启动前的配置检查：返回问题列表（空 = 可以启动）。 */
export function telegramConfigProblems(tcfg) {
  const problems = [];
  if (tcfg.invalidOwnerId) problems.push(`telegram.ownerId「${tcfg.invalidOwnerId}」不是 Telegram 用户 id（正整数）`);
  if (!BOT_TOKEN_RE.test(tcfg.botToken)) problems.push('telegram.botToken 为空或格式不对（应形如 123456789:AA…，找 @BotFather 要）');
  for (const [label, value] of [['telegram.proxy', tcfg.proxy], ['telegram.apiBase', tcfg.apiBase]]) {
    if (!value && label === 'telegram.proxy') continue;
    let u;
    try { u = new URL(value); } catch { problems.push(`${label} 不是合法地址：${value}`); continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') problems.push(`${label} 只支持 http:// 或 https://`);
    if (label === 'telegram.proxy' && u.protocol !== 'http:') problems.push('telegram.proxy 目前只支持 HTTP 代理（如 http://127.0.0.1:7890）');
  }
  return problems;
}

// ── HTTP（可走 HTTP CONNECT 代理）────────────────────────────────────────────

function openTunnel(proxyUrl, host, port, signal) {
  return new Promise((resolve, reject) => {
    const p = new URL(proxyUrl);
    const headers = { host: `${host}:${port}` };
    if (p.username || p.password) {
      const cred = `${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`;
      headers['proxy-authorization'] = `Basic ${Buffer.from(cred).toString('base64')}`;
    }
    const req = http.request({
      host: p.hostname,
      port: Number(p.port) || 80,
      method: 'CONNECT',
      path: `${host}:${port}`,
      headers,
      signal
    });
    req.once('connect', (res, socket) => {
      if (res.statusCode !== 200) {
        socket.destroy();
        reject(new Error(`代理拒绝了到 ${host}:${port} 的连接（HTTP ${res.statusCode}）`));
        return;
      }
      resolve(socket);
    });
    req.once('error', (error) => reject(new Error(`连不上代理 ${p.host}：${error?.message ?? error}`)));
    req.end();
  });
}

/**
 * 发一个 HTTP 请求，返回 { status, buffer }。
 * maxBytes 超限直接中断（防止被一个超大响应撑爆内存）。
 */
export async function telegramHttp(url, { method = 'GET', json, body: rawBody, contentType, proxy = '', timeoutMs = 20000, maxBytes = MAX_JSON_BYTES, signal } = {}) {
  const target = new URL(url);
  const isHttps = target.protocol === 'https:';
  const port = Number(target.port) || (isHttps ? 443 : 80);
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  const body = rawBody ?? (json === undefined ? null : Buffer.from(JSON.stringify(json)));
  const options = {
    method,
    hostname: target.hostname,
    port,
    path: target.pathname + target.search,
    headers: body ? { 'content-type': contentType || 'application/json', 'content-length': body.length } : {},
    signal: combined
  };
  if (proxy) {
    const socket = await openTunnel(proxy, target.hostname, port, combined);
    options.createConnection = () => (isHttps ? tls.connect({ socket, servername: target.hostname }) : socket);
  }
  return await new Promise((resolve, reject) => {
    const req = (isHttps ? https : http).request(options, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy(new Error(`响应超过 ${maxBytes} 字节上限`));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, buffer: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.on('error', (error) => {
      if (timeoutSignal.aborted) reject(new Error(`请求超时（${timeoutMs}ms）`));
      else reject(error);
    });
    if (body) req.write(body);
    req.end();
  });
}

/**
 * 拼一个 multipart/form-data 请求体：普通字段 + 一个文件。
 * 字段名、文件名、Content-Type 都是代码里写死的；字段值（如 caption 里的用户名）来自外部，
 * 但只出现在各段正文里，边界是 12 字节随机数，值里伪造不出新的段。
 */
export function buildMultipart(fields, file) {
  const boundary = `----qqbridge${crypto.randomBytes(12).toString('hex')}`;
  const parts = [];
  for (const [name, value] of Object.entries(fields)) {
    if (value === undefined || value === null) continue;
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${text}\r\n`));
  }
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`));
  parts.push(file.buffer);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const IMAGE_MIME = { gif: 'image/gif', png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
// Bot API：上传的照片最大 10 MB，动图（sendAnimation）最大 50 MB
const MAX_PHOTO_UPLOAD = 10 * 1024 * 1024;

export class TelegramApiError extends Error {
  constructor(message, code, retryAfter) {
    super(message);
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class TelegramClient {
  /** @param {{ botToken: string, apiBase?: string, proxy?: string }} opts */
  constructor({ botToken, apiBase = DEFAULT_API_BASE, proxy = '' }) {
    this.token = botToken;
    this.apiBase = apiBase.replace(/\/+$/, '');
    this.proxy = proxy;
  }

  /** 任何要打日志/回给调用方的文字都过一遍，别让 bot token 跟着 URL 漏出去。 */
  redact(text) {
    const s = String(text ?? '');
    return this.token ? s.split(this.token).join('***') : s;
  }

  async call(method, params = {}, { timeoutMs = 20000, signal, retried = false, file = null } = {}) {
    let res;
    try {
      const payload = file ? buildMultipart(params, file) : null;
      res = await telegramHttp(`${this.apiBase}/bot${this.token}/${method}`, {
        method: 'POST',
        ...(payload ? { body: payload.body, contentType: payload.contentType } : { json: params }),
        proxy: this.proxy, timeoutMs, signal
      });
    } catch (error) {
      throw new TelegramApiError(this.redact(`Telegram ${method} 网络错误：${error?.message ?? error}`), 'network');
    }
    let body;
    try { body = JSON.parse(res.buffer.toString('utf8')); } catch { body = null; }
    if (body?.ok === true) return body.result;
    const code = body?.error_code ?? res.status;
    const retryAfter = Number(body?.parameters?.retry_after) || 0;
    // 发太快被限流：等得不久就原地重试一次，等得久就交给调用方处理。
    const inlineRetryLimit = file ? 0 : (method.startsWith('send') ? MAX_INLINE_RETRY_SEC : 15);
    if (code === 429 && !retried && retryAfter > 0 && retryAfter <= inlineRetryLimit) {
      await sleep(retryAfter * 1000);
      return this.call(method, params, { timeoutMs, signal, retried: true, file });
    }
    const desc = body?.description || `HTTP ${res.status}`;
    throw new TelegramApiError(this.redact(`Telegram ${method} 失败：${desc}`), code, retryAfter);
  }

  getMe() {
    return this.call('getMe');
  }

  getUpdates(offset, timeoutSec, signal) {
    return this.call('getUpdates', {
      offset,
      timeout: timeoutSec,
      allowed_updates: ['message']
    }, { timeoutMs: (timeoutSec + 15) * 1000, signal });
  }

  /**
   * 发一条纯文字（不开 parse_mode：AI 的回复里随便一个 * 或 _ 都可能让 Markdown 解析失败）。
   * 超过上限时按上限切成多条。返回最后一条消息对象。
   */
  async sendText(chatId, text, { replyTo = null, mention = null, threadId = null } = {}) {
    let body = String(text ?? '');
    const entities = [];
    if (mention && mention.userId && mention.name) {
      const name = String(mention.name);
      body = `${name} ${body}`;
      entities.push({ type: 'text_mention', offset: 0, length: name.length, user: { id: Number(mention.userId) } });
    }
    const parts = [];
    for (let i = 0; i < body.length;) {
      let end = Math.min(body.length, i + MAX_TEXT_CHARS);
      // 别把 emoji 这类代理对从中间切开
      const c = body.charCodeAt(end - 1);
      if (end < body.length && c >= 0xd800 && c <= 0xdbff) end -= 1;
      parts.push(body.slice(i, end));
      i = end;
    }
    if (parts.length === 0) parts.push('');
    let last = null;
    for (let i = 0; i < parts.length; i++) {
      const params = { chat_id: chatId, text: parts[i] };
      if (i === 0 && entities.length) params.entities = entities;
      if (i === 0 && replyTo) params.reply_parameters = { message_id: Number(replyTo), allow_sending_without_reply: true };
      // 话题群（Topics）：不指定就会落到 General
      if (threadId) params.message_thread_id = Number(threadId);
      last = await this.call('sendMessage', params, { timeoutMs: SEND_TIMEOUT_MS });
    }
    return last;
  }

  /**
   * 发一张图片（上传字节）。GIF 用 sendAnimation 才会动，其它格式用 sendPhoto。
   * mention 放在图片说明里（text_mention），图片本身不带别的文字。
   */
  async sendImage(chatId, buffer, { replyTo = null, mention = null, threadId = null } = {}) {
    const ext = sniffImageExt(buffer);
    const animated = ext === 'gif';
    if (!animated && buffer.length > MAX_PHOTO_UPLOAD) throw new Error(`图片 ${buffer.length} 字节，超过 Telegram 照片上传上限 10 MB`);
    const params = { chat_id: chatId };
    if (mention && mention.userId && mention.name) {
      params.caption = String(mention.name);
      params.caption_entities = [{ type: 'text_mention', offset: 0, length: params.caption.length, user: { id: Number(mention.userId) } }];
    }
    if (replyTo) params.reply_parameters = { message_id: Number(replyTo), allow_sending_without_reply: true };
    if (threadId) params.message_thread_id = Number(threadId);
    const field = animated ? 'animation' : 'photo';
    return await this.call(animated ? 'sendAnimation' : 'sendPhoto', params, {
      timeoutMs: UPLOAD_TIMEOUT_MS,
      file: { field, filename: `sticker.${ext}`, contentType: IMAGE_MIME[ext] ?? 'application/octet-stream', buffer }
    });
  }

  /** 用 file_id 发一张已经在 Telegram 服务器上的贴纸（收到过的、或贴纸包里的）。 */
  async sendSticker(chatId, fileId, { replyTo = null, threadId = null } = {}) {
    const params = { chat_id: chatId, sticker: String(fileId) };
    if (replyTo) params.reply_parameters = { message_id: Number(replyTo), allow_sending_without_reply: true };
    if (threadId) params.message_thread_id = Number(threadId);
    return await this.call('sendSticker', params, { timeoutMs: SEND_TIMEOUT_MS });
  }

  // ── 贴纸包（bot 自己建、挂在某个用户名下；Bot API 没有读写用户收藏夹的接口）──

  /** 上传一个贴纸文件，返回 File（拿 file_id 去建包 / 加贴纸）。format：static | animated | video */
  async uploadStickerFile(userId, buffer, format) {
    const ext = format === 'video' ? 'webm' : format === 'animated' ? 'tgs' : 'png';
    const type = format === 'video' ? 'video/webm' : format === 'animated' ? 'application/x-tgsticker' : 'image/png';
    return await this.call('uploadStickerFile', { user_id: Number(userId), sticker_format: format }, {
      timeoutMs: UPLOAD_TIMEOUT_MS,
      file: { field: 'sticker', filename: `sticker.${ext}`, contentType: type, buffer }
    });
  }

  /** 读贴纸包；包不存在返回 null。 */
  async getStickerSet(name) {
    try {
      return await this.call('getStickerSet', { name });
    } catch (error) {
      if (error?.code === 400 && /STICKERSET_INVALID|not found|invalid/i.test(String(error.message))) return null;
      throw error;
    }
  }

  createNewStickerSet(userId, name, title, stickers) {
    return this.call('createNewStickerSet', { user_id: Number(userId), name, title, stickers });
  }

  addStickerToSet(userId, name, sticker) {
    return this.call('addStickerToSet', { user_id: Number(userId), name, sticker });
  }

  deleteStickerFromSet(fileId) {
    return this.call('deleteStickerFromSet', { sticker: String(fileId) });
  }

  /** 下载一个文件（图片）；超过 maxBytes 直接拒绝。 */
  async downloadFile(fileId, maxBytes) {
    const file = await this.call('getFile', { file_id: String(fileId) });
    if (file?.file_size && file.file_size > maxBytes) {
      throw new Error(`文件 ${file.file_size} 字节，超过上限 ${maxBytes}`);
    }
    const filePath = String(file?.file_path ?? '');
    if (!filePath || filePath.startsWith('/') || filePath.split('/').some((seg) => seg === '..' || seg === '')) {
      throw new Error('Telegram 返回的文件路径无效');
    }
    const encoded = filePath.split('/').map(encodeURIComponent).join('/');
    let res;
    try {
      res = await telegramHttp(`${this.apiBase}/file/bot${this.token}/${encoded}`, {
        proxy: this.proxy, timeoutMs: 30000, maxBytes
      });
    } catch (error) {
      throw new Error(this.redact(`下载 Telegram 文件失败：${error?.message ?? error}`));
    }
    if (res.status !== 200) throw new Error(`下载 Telegram 文件失败：HTTP ${res.status}`);
    return res.buffer;
  }
}

// ── 消息缓存（引用解析、@ 名字）────────────────────────────────────────────────

/**
 * Telegram 没有「按 id 取一条历史消息」的 Bot API，引用解析只能靠自己记：
 * 收到的消息、它引用的那条（update 里自带全文）、以及自己发出去的消息都记下来。
 */
export function createTelegramMessageCache(limit = 3000) {
  const messages = new Map(); // `${chatId}:${messageId}` -> { userId, sender, text }
  const names = new Map();    // `${chatId}:${userId}` -> name
  const threads = new Map();  // chatId -> 最近一条消息所在的话题 id（话题群用）
  const trim = (map) => {
    while (map.size > limit) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  };
  return {
    rememberName(chatId, userId, name) {
      if (!userId || !name) return;
      const k = `${chatId}:${userId}`;
      names.delete(k);
      names.set(k, String(name));
      trim(names);
    },
    nameOf(chatId, userId) {
      return names.get(`${chatId}:${userId}`) ?? null;
    },
    rememberThread(chatId, threadId) {
      threads.delete(String(chatId));
      if (threadId) threads.set(String(chatId), Number(threadId));
      trim(threads);
    },
    threadOf(chatId) {
      return threads.get(String(chatId)) ?? null;
    },
    remember(chatId, messageId, entry) {
      if (messageId == null) return;
      const k = `${chatId}:${messageId}`;
      messages.delete(k);
      messages.set(k, entry);
      trim(messages);
    },
    get(chatId, messageId) {
      return messages.get(`${chatId}:${messageId}`) ?? null;
    }
  };
}

// ── update → OneBot 形状事件 ──────────────────────────────────────────────────

export function displayNameOf(user) {
  if (!user) return '';
  const full = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return full || (user.username ? `@${user.username}` : String(user.id ?? ''));
}

function senderOf(msg) {
  if (msg.from) return { id: msg.from.id, name: displayNameOf(msg.from), isBot: msg.from.is_bot === true };
  // 匿名群管理员 / 频道身份发言：没有 from，只有 sender_chat
  if (msg.sender_chat) return { id: msg.sender_chat.id, name: msg.sender_chat.title || String(msg.sender_chat.id), isBot: false };
  return null;
}

const IMAGE_MIME_RE = /^image\/(png|jpe?g|gif|webp)$/i;

/** 一条消息里的媒体 → 段（只登记 file_id，不下载）。 */
function mediaSegments(msg, maxBytes) {
  const segs = [];
  if (Array.isArray(msg.photo) && msg.photo.length) {
    // photo 是同一张图的多个尺寸，从小到大排；挑不超过上限的最大那张。
    const fits = msg.photo.filter((p) => !p.file_size || p.file_size <= maxBytes);
    const pick = (fits.length ? fits : msg.photo)[(fits.length ? fits : msg.photo).length - 1];
    segs.push({ type: 'image', data: { file: `tgfile:${pick.file_id}`, url: '' } });
  }
  // GIF 动图会同时带 animation 和 document 两个字段，只按动图算一次
  if (msg.document && !msg.animation) {
    const d = msg.document;
    if (IMAGE_MIME_RE.test(String(d.mime_type ?? ''))) {
      segs.push({ type: 'image', data: { file: `tgfile:${d.file_id}`, url: '' } });
    } else {
      segs.push({ type: 'file', data: { name: d.file_name ? `:${d.file_name}` : '' } });
    }
  }
  if (msg.sticker) {
    const s = msg.sticker;
    const format = s.is_video ? 'video' : s.is_animated ? 'animated' : 'static';
    // 给模型看的图：静态贴纸就是它本身（WEBP），动态 / 视频贴纸用缩略图
    const viewId = format === 'static' ? s.file_id : s.thumbnail?.file_id;
    // tg_sticker 留着收藏用：收藏贴纸直接用原 file_id 进贴纸包，不用重新上传
    const tgSticker = { file_id: s.file_id, file_unique_id: s.file_unique_id, format, emoji: s.emoji || '' };
    if (viewId) {
      segs.push({ type: 'image', data: { file: `tgfile:${viewId}`, url: '', summary: s.emoji || '贴纸', tg_sticker: tgSticker } });
    } else {
      segs.push({ type: 'text', data: { text: `[贴纸${s.emoji ? `:${s.emoji}` : ''}]` } });
    }
  }
  if (msg.voice || msg.audio) segs.push({ type: 'record', data: {} });
  if (msg.video || msg.animation || msg.video_note) segs.push({ type: 'video', data: {} });
  return segs;
}

/** 文字 + 实体 → text / at 段。只有能对上人的 @ 才转成 at 段，其余原样留作文字。 */
function textSegments(text, entities, ctx) {
  const segs = [];
  if (!text) return segs;
  const pushText = (s) => { if (s) segs.push({ type: 'text', data: { text: s } }); };
  const mentions = (Array.isArray(entities) ? entities : [])
    .filter((e) => e && (e.type === 'mention' || e.type === 'text_mention'))
    .sort((a, b) => a.offset - b.offset);
  let pos = 0;
  for (const e of mentions) {
    if (e.offset < pos) continue;
    const piece = text.slice(e.offset, e.offset + e.length);
    let qq = null;
    if (e.type === 'text_mention' && e.user?.id) {
      qq = tgConvId(e.user.id);
      ctx.cache?.rememberName(ctx.chatId, qq, displayNameOf(e.user));
    } else if (e.type === 'mention' && ctx.botUsername && piece.slice(1).toLowerCase() === ctx.botUsername.toLowerCase()) {
      qq = ctx.selfId;
    }
    if (!qq) continue;
    pushText(text.slice(pos, e.offset));
    segs.push({ type: 'at', data: { qq } });
    pos = e.offset + e.length;
  }
  pushText(text.slice(pos));
  return segs;
}

/** 消息的纯文字摘要（存进引用缓存用）。 */
export function messagePlainText(msg) {
  const body = String(msg?.text ?? msg?.caption ?? '');
  const tags = [];
  if (msg?.photo || (msg?.document && !msg?.animation && IMAGE_MIME_RE.test(String(msg.document.mime_type ?? '')))) tags.push('[图片]');
  else if (msg?.document && !msg?.animation) tags.push('[文件]');
  if (msg?.sticker) tags.push(`[贴纸${msg.sticker.emoji ? `:${msg.sticker.emoji}` : ''}]`);
  if (msg?.voice || msg?.audio) tags.push('[语音]');
  if (msg?.video || msg?.animation || msg?.video_note) tags.push('[视频]');
  return (tags.join('') + body).trim();
}

/**
 * 把一条 Telegram update 转成桥接的事件。
 *
 * @param {object} update      getUpdates 返回的一项
 * @param {{ id: number, username?: string }} me   getMe 的结果
 * @param {{ cache?: ReturnType<typeof createTelegramMessageCache>, maxMediaBytes?: number, now?: number, maxAgeSec?: number }} [opts]
 * @returns {{ kind: 'private'|'group', id: string, event: object } | { skip: string } | null}
 */
export function updateToEvent(update, me, opts = {}) {
  const msg = update?.message;
  if (!msg || !msg.chat) return null;
  const { cache = null, maxMediaBytes = 8 * 1024 * 1024, now = Date.now(), maxAgeSec = 600 } = opts;
  const chatType = msg.chat.type;
  let kind;
  if (chatType === 'private') kind = 'private';
  else if (chatType === 'group' || chatType === 'supergroup') kind = 'group';
  else return { skip: `不处理 ${chatType} 类型的会话` };
  if (msg.migrate_to_chat_id) {
    return { skip: `群 ${msg.chat.id} 已升级为超级群，新 id 是 ${msg.migrate_to_chat_id}，请把新 id 加进 telegram.allow.groups` };
  }
  // 桥接停机期间积压的消息，重启后 Telegram 会一次性补发；太旧的就别再回了。
  if (Number(msg.date) > 0 && now / 1000 - Number(msg.date) > maxAgeSec) {
    return { skip: `丢弃 ${Math.round(now / 1000 - Number(msg.date))} 秒前的积压消息` };
  }
  const sender = senderOf(msg);
  if (!sender) return { skip: '消息没有发送者' };
  if (sender.id === me.id) return { skip: '自己发的消息' };

  const selfId = tgConvId(me.id);
  const chatId = msg.chat.id;
  const convId = tgConvId(chatId);
  const userId = tgConvId(sender.id);
  cache?.rememberName(chatId, userId, sender.name);

  let text = String(msg.text ?? msg.caption ?? '');
  const entities = msg.entities ?? msg.caption_entities ?? [];
  // 群里的命令带 bot 用户名后缀（/reset@my_bot）；去掉后缀，管理命令才认得出来。
  // 去掉的是开头这一段，之后的实体偏移要一起往前挪。
  let shift = 0;
  const cmd = /^\/[A-Za-z0-9_]+(@[A-Za-z0-9_]+)/.exec(text);
  if (cmd) {
    const suffix = cmd[1].slice(1).toLowerCase();
    if (me.username && suffix !== String(me.username).toLowerCase()) {
      return { skip: '发给别的 bot 的命令' };
    }
    shift = cmd[1].length;
    text = text.slice(0, cmd[0].length - shift) + text.slice(cmd[0].length);
  }
  if (/^\/start(\s|$)/.test(text)) return { skip: '/start（Telegram 首次对话自动发送）' };
  const shiftedEntities = shift
    ? entities.filter((e) => e.offset >= cmd[0].length).map((e) => ({ ...e, offset: e.offset - shift }))
    : entities;

  const segments = [];
  // 话题群里每条消息都自动「回复」话题的创建消息，那不是真的引用
  const reply = msg.reply_to_message?.forum_topic_created ? null : msg.reply_to_message;
  if (kind === 'group') cache?.rememberThread(chatId, msg.is_topic_message ? msg.message_thread_id : null);
  if (reply && reply.message_id != null) {
    segments.push({ type: 'reply', data: { id: String(reply.message_id) } });
    const rs = senderOf(reply);
    if (rs) {
      cache?.remember(chatId, reply.message_id, {
        userId: tgConvId(rs.id),
        sender: rs.name,
        text: messagePlainText(reply).slice(0, 200)
      });
    }
  }
  segments.push(...mediaSegments(msg, maxMediaBytes));
  segments.push(...textSegments(text, shiftedEntities, { chatId, selfId, botUsername: me.username, cache }));
  if (!segments.some((s) => s.type !== 'reply')) return { skip: '不支持的消息类型' };

  cache?.remember(chatId, msg.message_id, { userId, sender: sender.name, text: messagePlainText(msg).slice(0, 200) });

  const event = {
    post_type: 'message',
    message_type: kind,
    platform: 'telegram',
    self_id: selfId,
    user_id: userId,
    message_id: msg.message_id,
    time: msg.date,
    sender: { user_id: userId, nickname: sender.name, card: '' },
    message: segments,
    raw_message: text
  };
  if (kind === 'group') event.group_id = convId;
  return { kind, id: convId, event };
}

// ── 长轮询 ────────────────────────────────────────────────────────────────────

/**
 * 开始收消息。返回 stop()。
 *
 * 处理不阻塞轮询（和 QQ 那边事件回调并发执行一致），但同一个会话内按到达顺序串行，
 * 免得同一个人连发两句，后一句先进上下文。onUpdate 抛的错只记日志，不会打断轮询。
 */
export function startTelegramPolling({ client, timeoutSec = 30, onUpdate, log }) {
  const controller = new AbortController();
  let stopped = false;
  let offset = undefined;
  const chains = new Map(); // chatId -> Promise
  const dispatch = (u) => {
    const chatId = String(u?.message?.chat?.id ?? '');
    const prev = chains.get(chatId) ?? Promise.resolve();
    const next = prev
      .then(() => onUpdate(u))
      .catch((error) => log('处理 Telegram 消息出错:', client.redact(error?.message ?? error)))
      .finally(() => { if (chains.get(chatId) === next) chains.delete(chatId); });
    chains.set(chatId, next);
  };
  (async () => {
    let backoff = 3000;
    let lastError = '';
    while (!stopped) {
      try {
        const updates = await client.getUpdates(offset, timeoutSec, controller.signal);
        if (lastError) {
          log('Telegram 收消息已恢复');
          lastError = '';
        }
        backoff = 3000;
        for (const u of Array.isArray(updates) ? updates : []) {
          offset = Number(u.update_id) + 1;
          dispatch(u);
        }
      } catch (error) {
        if (stopped) break;
        const message = client.redact(error?.message ?? error);
        if (error?.code === 401 || error?.code === 404) {
          log(`⛔ Telegram botToken 无效（${message}），已停止 Telegram 接入。请检查 config.json 的 telegram.botToken`);
          return;
        }
        let hint = '';
        if (error?.code === 409) hint = '（同一个 bot 有别的程序在收消息，或者设置了 webhook；一个 bot 只能有一个接收方）';
        else if (error?.code === 'network') hint = '（国内一般要配 telegram.proxy，比如 http://127.0.0.1:7890）';
        if (message !== lastError) log(`⚠️ Telegram 收消息失败：${message}${hint}；${Math.round(backoff / 1000)} 秒后重试`);
        lastError = message;
        await sleep(backoff);
        backoff = Math.min(60000, backoff * 2);
      }
    }
  })();
  return () => {
    stopped = true;
    controller.abort();
  };
}
