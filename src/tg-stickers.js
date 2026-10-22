// 她在 Telegram 上的贴纸：两个由 bot 建、挂在管理员名下的贴纸包。
//
//   fav：Telegram 收藏 —— 她在 Telegram 会话里看到喜欢的贴纸/图片，用收藏工具加进来（对应 QQ 的收藏表情）
//   qq ：QQ 表情同步 —— 把 QQ 收藏表情转成 Telegram 贴纸放进来，在 Telegram 上发出去是真贴纸而不是图片
//
// 为什么是"贴纸包"：Bot API 没有任何读写用户收藏夹 / 最近使用贴纸的接口，bot 能长期保存贴纸的
// 唯一办法是自己建包（createNewStickerSet / addStickerToSet）。包名必须以 _by_<bot 用户名> 结尾，
// 必须挂在一个真人用户名下（这里用 telegram.ownerId），一个包最多 120 张。
//
// ⚠️ 贴纸包是公开的：知道包名的人都能打开 t.me/addstickers/<包名>。所以两个功能默认都关着，
// 要管理员在配置里明确打开（telegram.stickers.favorites / syncQQ）。
//
// 自己上传的贴纸有规格要求（https://core.telegram.org/stickers）：
//   静态：PNG/WEBP，一边正好 512 像素、另一边不超过 512
//   视频：WEBM（VP9），一边 512，≤ 3 秒，≤ 30 fps，≤ 256 KB，无音轨
// 转换用 ffmpeg（语音功能本来就依赖它）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { sniffImageExt } from './onebot-impl.js';

export const SET_LIMIT = 120;
const MAX_STATIC_BYTES = 512 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024;
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,255}$/;
// emoji：基础字符 + 可选的肤色 / 变体选择符 / 零宽连接的组合
const EMOJI_RE = /\p{Extended_Pictographic}(?:\p{Emoji_Modifier}|\p{Variation_Selector}|\p{Join_Control}\p{Extended_Pictographic})*/gu;
const VS16 = String.fromCodePoint(0xfe0f);
const CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const cleanNote = (v, max = 60) => String(v ?? '').replace(CONTROL_RE, ' ').trim().slice(0, max);
// 同一张 QQ 表情连续转换 / 上传失败这么多次就不再每轮重试（比如 ffmpeg 解不了的动态 WebP）
const MAX_QQ_FAILURES = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 纯函数 ────────────────────────────────────────────────────────────────

/**
 * 贴纸包名里带的一小段标记：由 bot id 和管理员 id 算出来（哈希，不会把管理员的 Telegram id 公开出去）。
 * 换了 bot 或管理员，包名跟着变：file_id 只对建它的 bot 有效、包也只属于建它时的那个人，旧包接着用不了。
 */
export function stickerSetTag(botId, ownerId) {
  return crypto.createHash('sha256').update(`${botId}:${ownerId}`).digest('hex').slice(0, 6);
}

/** 两个包的名字。Telegram 规定：字母开头、只含字母数字下划线、不能连续下划线、以 _by_<bot> 结尾、≤ 64。 */
export function stickerSetNames(botUsername, tag) {
  const bot = String(botUsername ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{2,}$/.test(bot) || bot.includes('__')) throw new Error(`bot 用户名不合法：${bot}`);
  if (!/^[0-9a-f]{6}$/.test(String(tag ?? ''))) throw new Error('贴纸包标记不合法');
  const make = (prefix) => {
    const name = `${prefix}_${tag}_by_${bot}`;
    if (name.length > 64) throw new Error(`贴纸包名太长：${name}`);
    return name;
  };
  return { fav: make('her_fav'), qq: make('her_qq') };
}

/** 一个 emoji：只有文字样式的符号（© ‼ 这类）补上 U+FE0F，Telegram 才认它是 emoji。 */
function normalizeEmoji(e) {
  if (e.includes(VS16) || /\p{Emoji_Presentation}/u.test(e)) return e;
  return e + VS16;
}

/** 从备注里挑 emoji（贴纸至少要 1 个，最多 20 个）；挑不到就用默认的。 */
export function emojiListFor(texts, fallback = '🙂') {
  const found = [];
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(EMOJI_RE)) {
      const e = normalizeEmoji(m[0]);
      if (!found.includes(e)) found.push(e);
      if (found.length >= 20) return found;
    }
  }
  if (found.length) return found;
  const fb = String(fallback ?? '').match(EMOJI_RE)?.[0];
  return [fb ? normalizeEmoji(fb) : '🙂'];
}

/** 搜索关键词：最多 20 个、总长 ≤ 64。 */
export function keywordsFor(texts) {
  const out = [];
  let total = 0;
  for (const t of texts) {
    for (const word of String(t ?? '').replace(EMOJI_RE, ' ').split(/[\s,，、;；/|]+/)) {
      const w = word.trim().slice(0, 20);
      if (!w || out.includes(w)) continue;
      if (out.length >= 20 || total + w.length > 64) return out;
      out.push(w);
      total += w.length;
    }
  }
  return out;
}

/** GIF 里有不止一帧才算动图（单帧 GIF 当静态图处理）。 */
export function isAnimatedGif(buffer) {
  if (sniffImageExt(buffer) !== 'gif') return false;
  let count = 0;
  for (let i = 0; i + 2 < buffer.length; i++) {
    // 图形控制扩展块 0x21 0xF9 0x04：每一帧前面一个
    if (buffer[i] === 0x21 && buffer[i + 1] === 0xf9 && buffer[i + 2] === 0x04 && ++count > 1) return true;
  }
  return false;
}

// ── ffmpeg 转换 ──────────────────────────────────────────────────────────

/** ffmpeg 能不能用（启动时检查一次，免得同步时每张表情都失败一遍）。 */
export function ffmpegAvailable(ffmpeg = 'ffmpeg') {
  try {
    return spawnSync(ffmpeg, ['-version'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }).status === 0;
  } catch {
    return false;
  }
}

function runFfmpeg(ffmpeg, args, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let child;
    let stderr = '';
    try {
      child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (error) {
      resolve({ ok: false, error: `ffmpeg 启动失败：${error?.message ?? error}` });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch {} resolve({ ok: false, error: 'ffmpeg 超时' }); }, timeoutMs);
    child.stderr.on('data', (c) => { if (stderr.length < 2000) stderr += c; });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: e.code === 'ENOENT' ? '找不到 ffmpeg（装一个，或设置 FFMPEG_PATH / socialV2.voice.ffmpegPath）' : `ffmpeg 不可用：${e.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0 ? { ok: true } : { ok: false, error: `ffmpeg 退出码 ${code}：${stderr.trim().split('\n').pop() ?? ''}` });
    });
  });
}

const FIT_512 = 'scale=512:512:force_original_aspect_ratio=decrease:flags=lanczos';

/**
 * 图片字节 → 能进贴纸包的文件。动图 GIF 转视频贴纸（WEBM，超过 3 秒的截掉后面），
 * 其它格式取第一帧转静态 PNG。ffmpeg 解不了的格式（比如部分版本解不了动态 WebP）会抛错。
 * @returns {Promise<{ buffer: Buffer, format: 'static' | 'video' }>}
 */
export async function convertToSticker(buffer, { ffmpeg = 'ffmpeg', tmpRoot = os.tmpdir() } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'qq-bridge-tgsticker-'));
  try {
    try { fs.chmodSync(dir, 0o700); } catch {}
    const input = path.join(dir, `in.${sniffImageExt(buffer)}`);
    fs.writeFileSync(input, buffer, { mode: 0o600 });
    if (isAnimatedGif(buffer)) {
      const out = path.join(dir, 'out.webm');
      // 先按质量压，超过 256 KB 再降画质 / 帧率
      for (const [crf, fps] of [[38, 30], [48, 24], [56, 15]]) {
        const r = await runFfmpeg(ffmpeg, ['-v', 'error', '-y', '-i', input, '-t', '2.9', '-an',
          '-vf', `${FIT_512},fps=${fps}`, '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
          '-b:v', '0', '-crf', String(crf), '-deadline', 'good', '-row-mt', '1', out]);
        if (!r.ok) throw new Error(r.error);
        const bytes = fs.readFileSync(out);
        if (bytes.length <= MAX_VIDEO_BYTES) return { buffer: bytes, format: 'video' };
      }
      throw new Error('动图压到 256 KB 以内失败（太长或画面太复杂）');
    }
    const out = path.join(dir, 'out.png');
    let r = await runFfmpeg(ffmpeg, ['-v', 'error', '-y', '-i', input, '-frames:v', '1', '-vf', FIT_512, out]);
    if (!r.ok) throw new Error(r.error);
    let bytes = fs.readFileSync(out);
    if (bytes.length > MAX_STATIC_BYTES) {
      // 色彩太丰富时 PNG 会超过 512 KB：换成 256 色调色板（保留透明）
      r = await runFfmpeg(ffmpeg, ['-v', 'error', '-y', '-i', input, '-frames:v', '1',
        '-vf', `${FIT_512},split[a][b];[b]palettegen=reserve_transparent=1[p];[a][p]paletteuse`, out]);
      if (!r.ok) throw new Error(r.error);
      bytes = fs.readFileSync(out);
      if (bytes.length > MAX_STATIC_BYTES) throw new Error('图片压到 512 KB 以内失败');
    }
    return { buffer: bytes, format: 'static' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Telegram 贴纸 → QQ 收藏表情能用的图片。QQ 不认 WEBP / WEBM：
 *   static（WEBP）→ PNG；video（WEBM，带透明）→ GIF（最长 3 秒、240 像素宽、256 色调色板）。
 * 动画贴纸（TGS，矢量）要专门的渲染器，这里不处理，调用方改用它的缩略图（按 static 传进来）。
 * @returns {Promise<Buffer>}
 */
export async function convertStickerForQQ(buffer, format, { ffmpeg = 'ffmpeg', tmpRoot = os.tmpdir(), maxBytes = 8 * 1024 * 1024 } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpRoot, 'qq-bridge-tgsticker-'));
  try {
    try { fs.chmodSync(dir, 0o700); } catch {}
    if (format === 'video') {
      const input = path.join(dir, 'in.webm');
      fs.writeFileSync(input, buffer, { mode: 0o600 });
      const out = path.join(dir, 'out.gif');
      const gifArgs = ['-t', '3',
        '-vf', 'fps=15,scale=240:240:force_original_aspect_ratio=decrease:flags=lanczos,split[a][b];[b]palettegen=reserve_transparent=1[p];[a][p]paletteuse',
        '-loop', '0', out];
      // 指定 libvpx-vp9 解码器才能读到透明通道；ffmpeg 没带 libvpx 时退回自带解码器（透明背景会变成实底）
      let r = await runFfmpeg(ffmpeg, ['-v', 'error', '-y', '-c:v', 'libvpx-vp9', '-i', input, ...gifArgs]);
      if (!r.ok) r = await runFfmpeg(ffmpeg, ['-v', 'error', '-y', '-i', input, ...gifArgs]);
      if (!r.ok) throw new Error(r.error);
      const bytes = fs.readFileSync(out);
      if (bytes.length > maxBytes) throw new Error('转出来的 GIF 太大');
      return bytes;
    }
    const input = path.join(dir, `in.${sniffImageExt(buffer)}`);
    fs.writeFileSync(input, buffer, { mode: 0o600 });
    const out = path.join(dir, 'out.png');
    const r = await runFfmpeg(ffmpeg, ['-v', 'error', '-y', '-i', input, '-frames:v', '1', out]);
    if (!r.ok) throw new Error(r.error);
    const bytes = fs.readFileSync(out);
    if (bytes.length > maxBytes) throw new Error('转出来的图片太大');
    return bytes;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// ── 本地记录 ──────────────────────────────────────────────────────────────

function emptyStore(binding = '') {
  return { version: 2, binding, sets: {}, favorites: [], qq: {}, qqFailed: {} };
}

function cleanFavorite(f) {
  if (!f || !FILE_ID_RE.test(String(f.fileId ?? '')) || !String(f.fileUniqueId ?? '')) return null;
  return {
    id: `tg:${String(f.fileUniqueId).slice(0, 64)}`,
    fileId: String(f.fileId),
    fileUniqueId: String(f.fileUniqueId).slice(0, 64),
    // 收藏来源那张贴纸的 file_unique_id（进包后包里那张的 id 不一定一样），用来判断重复收藏
    sourceUniqueId: String(f.sourceUniqueId ?? '').slice(0, 64),
    format: ['static', 'animated', 'video'].includes(f.format) ? f.format : 'static',
    emoji: String(f.emoji ?? '').slice(0, 16),
    note: cleanNote(f.note),
    thumbFileId: FILE_ID_RE.test(String(f.thumbFileId ?? '')) ? String(f.thumbFileId) : '',
    addedAt: Number(f.addedAt) || Date.now(),
    useCount: Math.max(0, Number(f.useCount) || 0),
    lastUsedAt: Number(f.lastUsedAt) || 0
  };
}

/** 收到的 Telegram 贴纸的引用信息（从消息段里来，进存储前清洗一遍）。 */
export function cleanTgStickerRef(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const fileId = String(raw.file_id ?? raw.fileId ?? '');
  const fileUniqueId = String(raw.file_unique_id ?? raw.fileUniqueId ?? '').slice(0, 64);
  if (!FILE_ID_RE.test(fileId) || !/^[A-Za-z0-9_-]{4,64}$/.test(fileUniqueId)) return null;
  const format = ['static', 'animated', 'video'].includes(raw.format) ? raw.format : 'static';
  const emoji = String(raw.emoji ?? '').match(EMOJI_RE)?.[0] ?? '';
  return { fileId, fileUniqueId, format, emoji };
}

export function loadTgStickerStore(file) {
  if (!fs.existsSync(file)) return emptyStore();
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const store = emptyStore(/^[0-9a-f]{6}$/.test(String(raw?.binding ?? '')) ? raw.binding : '');
  if (raw?.sets && typeof raw.sets === 'object') {
    for (const k of ['fav', 'qq']) if (raw.sets[k]?.name) store.sets[k] = { name: String(raw.sets[k].name), createdAt: Number(raw.sets[k].createdAt) || 0 };
  }
  store.favorites = (Array.isArray(raw?.favorites) ? raw.favorites : []).map(cleanFavorite).filter(Boolean).slice(0, SET_LIMIT);
  for (const [md5, v] of Object.entries(raw?.qq && typeof raw.qq === 'object' ? raw.qq : {})) {
    if (!/^[0-9A-F]{32}$/.test(md5) || !FILE_ID_RE.test(String(v?.fileId ?? ''))) continue;
    store.qq[md5] = { fileId: String(v.fileId), fileUniqueId: String(v.fileUniqueId ?? '').slice(0, 64), format: v.format === 'video' ? 'video' : 'static', syncedAt: Number(v.syncedAt) || 0 };
  }
  for (const [md5, v] of Object.entries(raw?.qqFailed && typeof raw.qqFailed === 'object' ? raw.qqFailed : {})) {
    if (!/^[0-9A-F]{32}$/.test(md5)) continue;
    store.qqFailed[md5] = { count: Math.max(0, Number(v?.count) || 0), lastAt: Number(v?.lastAt) || 0, reason: cleanNote(v?.reason, 120) };
  }
  return store;
}

export function saveTgStickerStore(file, store) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// ── 贴纸包管理 ────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {import('./telegram.js').TelegramClient} opts.client
 * @param {number} opts.ownerId        贴纸包挂在谁名下（telegram.ownerId）
 * @param {{ id: number, username: string, first_name?: string }} opts.me
 * @param {string} opts.storeFile
 * @param {(buf: Buffer) => Promise<{buffer: Buffer, format: string}>} opts.convert
 * @param {string} [opts.defaultEmoji]
 * @param {(...a: any[]) => void} [opts.log]
 * @param {number} [opts.gapMs]       连续改包之间的间隔（避开 Telegram 限流）
 */
export function createTgStickerManager({ client, ownerId, me, storeFile, convert, defaultEmoji = '🙂', log = () => {}, gapMs = 1500 }) {
  const tag = stickerSetTag(me.id, ownerId);
  const names = stickerSetNames(me.username, tag);
  let store = loadTgStickerStore(storeFile);
  if (store.binding !== tag) {
    // 换了 bot 或管理员（或第一次用）：旧记录里的 file_id 和包都用不了了，从头来
    if (store.binding) log(`[tg-sticker] bot 或 ownerId 变了，旧的贴纸包记录作废，改用新包 ${names.fav} / ${names.qq}`);
    store = emptyStore(tag);
    saveTgStickerStore(storeFile, store);
  }
  let chain = Promise.resolve();
  // 所有改包的操作串行：同步任务和收藏可能同时发生，并发改同一个包会互相踩
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const save = () => saveTgStickerStore(storeFile, store);
  const title = (kind) => `${me.first_name || me.username} 的${kind === 'fav' ? '收藏' : ' QQ 表情'}`.slice(0, 64);
  const isMissing = (error) => /STICKER_INVALID|STICKERSET_INVALID|not found/i.test(String(error?.message ?? ''));

  /** 读包；刚改完包时读可能失败（网络 / 限流），多试两次。 */
  async function readSet(name, tries = 3) {
    let lastError;
    for (let i = 0; i < tries; i++) {
      try { return await client.getStickerSet(name); } catch (error) { lastError = error; }
      if (gapMs) await sleep(gapMs);
    }
    throw lastError;
  }

  /**
   * 本地记录和包里的实际内容对账。加贴纸成功、但随后读包失败时，包里会多出本地不知道的贴纸；
   * 本地记录丢了 / 重置过也一样。不对账的话这些贴纸永远删不掉，迟早把 120 张占满。
   *   qq 包：只归同步管，多出来的删掉；本地记着但包里没了的，忘掉（下一轮重新传）。
   *   fav 包：多出来的都是她收藏过的，补记成收藏（备注空着）；包里没了的，从收藏里去掉。
   */
  async function reconcile(kind) {
    const set = await readSet(names[kind]);
    const inSet = new Map((set?.stickers ?? []).map((st) => [st.file_unique_id, st]));
    let changed = false;
    if (kind === 'qq') {
      const tracked = new Set();
      for (const [md5, v] of Object.entries(store.qq)) {
        const st = inSet.get(v.fileUniqueId);
        if (!st) { delete store.qq[md5]; changed = true; continue; }
        tracked.add(v.fileUniqueId);
        if (st.file_id !== v.fileId) { v.fileId = st.file_id; changed = true; }
      }
      for (const st of inSet.values()) {
        if (tracked.has(st.file_unique_id)) continue;
        try {
          await client.deleteStickerFromSet(st.file_id);
          log('[tg-sticker] QQ 表情包里有一张本地没记录的贴纸，已删掉');
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (gapMs) await sleep(gapMs);
      }
    } else {
      const before = store.favorites.length;
      store.favorites = store.favorites.filter((f) => {
        const st = inSet.get(f.fileUniqueId);
        if (st && st.file_id !== f.fileId) { f.fileId = st.file_id; changed = true; }
        return !!st;
      });
      if (store.favorites.length !== before) changed = true;
      const known = new Set(store.favorites.map((f) => f.fileUniqueId));
      for (const st of inSet.values()) {
        if (known.has(st.file_unique_id)) continue;
        const fav = cleanFavorite({
          fileId: st.file_id, fileUniqueId: st.file_unique_id,
          format: st.is_video ? 'video' : st.is_animated ? 'animated' : 'static',
          emoji: st.emoji ?? '', thumbFileId: st.thumbnail?.file_id ?? ''
        });
        if (fav) { store.favorites.push(fav); changed = true; }
      }
    }
    if (set && !store.sets[kind]) { store.sets[kind] = { name: names[kind], createdAt: Date.now() }; changed = true; }
    if (changed) save();
    return set;
  }

  /** 往包里加一张，返回包里那张贴纸（拿它的 file_id 发送 / 删除）。包还没建就建。 */
  async function addToSet(kind, inputSticker, before) {
    const name = names[kind];
    if (before && before.stickers.length >= SET_LIMIT) throw new Error(`贴纸包 ${name} 已满（${SET_LIMIT} 张）`);
    const seen = new Set((before?.stickers ?? []).map((st) => st.file_unique_id));
    if (before) await client.addStickerToSet(ownerId, name, inputSticker);
    else await client.createNewStickerSet(ownerId, name, title(kind), [inputSticker]);
    if (!store.sets[kind]) {
      store.sets[kind] = { name, createdAt: Date.now() };
      save();
    }
    const after = await readSet(name);
    const added = (after?.stickers ?? []).filter((st) => !seen.has(st.file_unique_id)).pop();
    if (!added) throw new Error('这张已经在贴纸包里了');
    return { added, after };
  }

  async function uploadConverted(buffer) {
    const converted = await convert(buffer);
    const file = await client.uploadStickerFile(ownerId, converted.buffer, converted.format);
    return { fileId: file.file_id, format: converted.format };
  }

  return {
    names,
    get store() { return store; },

    favorites() { return store.favorites.slice(); },

    findFavorite(ref) {
      const r = String(ref ?? '').trim();
      return store.favorites.find((f) => f.id === r || f.fileUniqueId === r) ?? null;
    },

    qqFileIdFor(md5) {
      return store.qq[String(md5 ?? '').toUpperCase()]?.fileId ?? null;
    },

    /**
     * B：收藏一张 Telegram 上看到的贴纸或图片。
     * source：{ sticker: { fileId, fileUniqueId, format, emoji } } 收到的贴纸，原样进包（不用重新上传）；
     *         { image: Buffer } 图片，先转成贴纸规格再上传。
     */
    collect(source, note = '') {
      return serial(async () => {
        const before = await reconcile('fav');
        const srcId = source.sticker?.fileUniqueId;
        if (srcId && store.favorites.some((f) => f.fileUniqueId === srcId || f.sourceUniqueId === srcId)) {
          throw new Error('这张已经收藏过了');
        }
        const cleanedNote = cleanNote(note);
        let input;
        let emoji;
        if (source.sticker) {
          emoji = emojiListFor([source.sticker.emoji, cleanedNote], defaultEmoji);
          input = { sticker: source.sticker.fileId, format: source.sticker.format, emoji_list: emoji, keywords: keywordsFor([cleanedNote]) };
        } else {
          const up = await uploadConverted(source.image);
          emoji = emojiListFor([cleanedNote], defaultEmoji);
          input = { sticker: up.fileId, format: up.format, emoji_list: emoji, keywords: keywordsFor([cleanedNote]) };
        }
        const { added } = await addToSet('fav', input, before);
        const fav = cleanFavorite({
          fileId: added.file_id,
          fileUniqueId: added.file_unique_id,
          format: added.is_video ? 'video' : added.is_animated ? 'animated' : 'static',
          emoji: emoji[0],
          note: cleanedNote,
          thumbFileId: added.thumbnail?.file_id ?? '',
          sourceUniqueId: srcId ?? '',
          addedAt: Date.now()
        });
        store.favorites.push(fav);
        save();
        return fav;
      });
    },

    noteFavorite(ref, note) {
      const f = this.findFavorite(ref);
      if (!f) return null;
      f.note = cleanNote(note);
      save();
      return f;
    },

    markFavoriteUsed(ref) {
      const f = this.findFavorite(ref);
      if (!f) return;
      f.useCount += 1;
      f.lastUsedAt = Date.now();
      save();
    },

    /**
     * C：把 QQ 收藏表情同步进 qq 包。新增的转换上传，QQ 里删掉的从包里删掉。
     * 一轮最多尝试 maxAdds 张（成功失败都算），免得一口气打满 Telegram 限流；
     * 同一张连续失败 3 次就不再重试（md5 是内容哈希，同一张图下次多半还是失败）。
     * @param {Array<{md5: string, desc?: string, localNote?: string, tags?: string[], useCount?: number}>} entries
     * @param {(entry: object) => Promise<Buffer>} download
     */
    syncQq(entries, download, { maxAdds = 20 } = {}) {
      return serial(async () => {
        const result = { added: 0, removed: 0, failed: 0, skipped: 0, gaveUp: 0 };
        const present = (Array.isArray(entries) ? entries : [])
          .filter((e) => /^[0-9A-F]{32}$/.test(String(e?.md5 ?? '').toUpperCase()));
        // 一张能认的都没有（网关没连上、表情库没同步过、或者条目都缺 md5）：别动包，空列表会被当成「全删了」
        if (!present.length) return result;
        let set = await reconcile('qq');
        // 已经同步过、QQ 里还在的先占位；剩下的名额按使用次数补。
        // 不这样的话，超过 120 张时使用次数一变，包里的贴纸就会反复删了又加。
        const kept = present.filter((e) => store.qq[e.md5.toUpperCase()]);
        const fresh = present.filter((e) => !store.qq[e.md5.toUpperCase()])
          .sort((a, b) => (b.useCount || 0) - (a.useCount || 0));
        const wanted = [...kept, ...fresh].slice(0, SET_LIMIT);
        const wantedMd5 = new Set(wanted.map((e) => e.md5.toUpperCase()));
        for (const [md5, v] of Object.entries(store.qq)) {
          if (wantedMd5.has(md5)) continue;
          try {
            await client.deleteStickerFromSet(v.fileId);
          } catch (error) {
            // 包里已经没有它了也算删掉
            if (!isMissing(error)) { result.failed += 1; log(`[tg-sticker] 删除同步贴纸失败：${error?.message ?? error}`); continue; }
          }
          delete store.qq[md5];
          result.removed += 1;
          save();
          if (gapMs) await sleep(gapMs);
        }
        if (result.removed) set = await readSet(names.qq);
        let attempts = 0;
        for (const e of wanted) {
          const md5 = e.md5.toUpperCase();
          if (store.qq[md5]) continue;
          if ((store.qqFailed[md5]?.count ?? 0) >= MAX_QQ_FAILURES) { result.gaveUp += 1; continue; }
          if (attempts >= maxAdds) { result.skipped += 1; continue; }
          attempts += 1;
          try {
            const buf = await download(e);
            const up = await uploadConverted(buf);
            const texts = [e.desc, e.localNote, ...(e.tags || [])];
            const { added, after } = await addToSet('qq', { sticker: up.fileId, format: up.format, emoji_list: emojiListFor(texts, defaultEmoji), keywords: keywordsFor(texts) }, set);
            set = after;
            store.qq[md5] = { fileId: added.file_id, fileUniqueId: added.file_unique_id, format: up.format, syncedAt: Date.now() };
            delete store.qqFailed[md5];
            save();
            result.added += 1;
          } catch (error) {
            result.failed += 1;
            const prev = store.qqFailed[md5]?.count ?? 0;
            store.qqFailed[md5] = { count: prev + 1, lastAt: Date.now(), reason: cleanNote(error?.message ?? error, 120) };
            save();
            log(`[tg-sticker] 同步 QQ 表情 ${md5.slice(0, 8)} 失败（第 ${prev + 1} 次）：${error?.message ?? error}`);
            if (/已满/.test(String(error?.message))) break;
            if (error?.code === 429) break; // 被限流就留到下一轮
            // 读包失败时不知道包的现状，重新对账再继续
            try { set = await readSet(names.qq); } catch { break; }
          }
          if (gapMs) await sleep(gapMs);
        }
        return result;
      });
    }
  };
}
