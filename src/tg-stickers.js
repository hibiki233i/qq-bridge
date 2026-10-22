// 她在 Telegram 上的贴纸：两个由 bot 建、挂在管理员名下的贴纸包。
//
//   fav：Telegram 收藏 —— 她在 Telegram 会话里看到喜欢的贴纸/图片，用收藏工具加进来（对应 QQ 的收藏表情）
//   qq ：QQ 表情同步 —— 把 QQ 收藏表情转成 Telegram 贴纸放进来，在 Telegram 上发出去是真贴纸而不是图片
//
// 为什么是"贴纸包"：Bot API 没有任何读写用户收藏夹 / 最近使用贴纸的接口，bot 能长期保存贴纸的
// 唯一办法是自己建包（createNewStickerSet / addStickerToSet）。包名必须以 _by_<bot 用户名> 结尾，
// 必须挂在一个真人用户名下（这里用 telegram.ownerId），一个包最多 120 张。
//
// 自己上传的贴纸有规格要求（https://core.telegram.org/stickers）：
//   静态：PNG/WEBP，一边正好 512 像素、另一边不超过 512
//   视频：WEBM（VP9），一边 512，≤ 3 秒，≤ 30 fps，≤ 256 KB，无音轨
// 转换用 ffmpeg（语音功能本来就依赖它）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { sniffImageExt } from './onebot-impl.js';

export const SET_LIMIT = 120;
const MAX_STATIC_BYTES = 512 * 1024;
const MAX_VIDEO_BYTES = 256 * 1024;
const FILE_ID_RE = /^[A-Za-z0-9_-]{10,255}$/;
const EMOJI_RE = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu;

// ── 纯函数 ────────────────────────────────────────────────────────────────

/** 两个包的名字。Telegram 规定：字母开头、只含字母数字下划线、不能连续下划线、以 _by_<bot> 结尾、≤ 64。 */
export function stickerSetNames(botUsername) {
  const bot = String(botUsername ?? '').trim();
  if (!/^[A-Za-z][A-Za-z0-9_]{2,}$/.test(bot) || bot.includes('__')) throw new Error(`bot 用户名不合法：${bot}`);
  const make = (prefix) => {
    const name = `${prefix}_by_${bot}`;
    if (name.length > 64) throw new Error(`贴纸包名太长：${name}`);
    return name;
  };
  return { fav: make('her_fav'), qq: make('her_qq') };
}

/** 从备注里挑 emoji（贴纸至少要 1 个，最多 20 个）；挑不到就用默认的。 */
export function emojiListFor(texts, fallback = '🙂') {
  const found = [];
  for (const t of texts) {
    for (const m of String(t ?? '').matchAll(EMOJI_RE)) {
      if (!found.includes(m[0])) found.push(m[0]);
      if (found.length >= 20) return found;
    }
  }
  if (found.length) return found;
  const fb = String(fallback ?? '').match(EMOJI_RE)?.[0];
  return [fb || '🙂'];
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
 * 图片字节 → 能进贴纸包的文件。动图 GIF 转视频贴纸（WEBM），其它一律取第一帧转静态 PNG。
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

// ── 本地记录 ──────────────────────────────────────────────────────────────

function emptyStore() {
  return { version: 1, sets: {}, favorites: [], qq: {} };
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
    note: String(f.note ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').slice(0, 60),
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
  const store = emptyStore();
  if (raw?.sets && typeof raw.sets === 'object') {
    for (const k of ['fav', 'qq']) if (raw.sets[k]?.name) store.sets[k] = { name: String(raw.sets[k].name), createdAt: Number(raw.sets[k].createdAt) || 0 };
  }
  store.favorites = (Array.isArray(raw?.favorites) ? raw.favorites : []).map(cleanFavorite).filter(Boolean).slice(0, SET_LIMIT);
  for (const [md5, v] of Object.entries(raw?.qq && typeof raw.qq === 'object' ? raw.qq : {})) {
    if (!/^[0-9A-F]{32}$/.test(md5) || !FILE_ID_RE.test(String(v?.fileId ?? ''))) continue;
    store.qq[md5] = { fileId: String(v.fileId), fileUniqueId: String(v.fileUniqueId ?? '').slice(0, 64), format: v.format === 'video' ? 'video' : 'static', syncedAt: Number(v.syncedAt) || 0 };
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
 * @param {{ username: string, first_name?: string }} opts.me
 * @param {string} opts.storeFile
 * @param {(buf: Buffer) => Promise<{buffer: Buffer, format: string}>} opts.convert
 * @param {string} [opts.defaultEmoji]
 * @param {(...a: any[]) => void} [opts.log]
 */
export function createTgStickerManager({ client, ownerId, me, storeFile, convert, defaultEmoji = '🙂', log = () => {} }) {
  const names = stickerSetNames(me.username);
  let store = loadTgStickerStore(storeFile);
  let chain = Promise.resolve();
  // 所有改包的操作串行：同步任务和收藏可能同时发生，并发改同一个包会互相踩
  const serial = (fn) => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  };
  const save = () => saveTgStickerStore(storeFile, store);
  const title = (kind) => `${me.first_name || me.username} 的${kind === 'fav' ? '收藏' : ' QQ 表情'}`.slice(0, 64);

  /** 往包里加一张，返回包里那张贴纸（拿它的 file_id 发送 / 删除）。包还没建就建。 */
  async function addToSet(kind, inputSticker) {
    const name = names[kind];
    const before = await client.getStickerSet(name);
    if (before && before.stickers.length >= SET_LIMIT) throw new Error(`贴纸包 ${name} 已满（${SET_LIMIT} 张）`);
    const seen = new Set((before?.stickers ?? []).map((s) => s.file_unique_id));
    if (before) await client.addStickerToSet(ownerId, name, inputSticker);
    else await client.createNewStickerSet(ownerId, name, title(kind), [inputSticker]);
    if (!store.sets[kind]) {
      store.sets[kind] = { name, createdAt: Date.now() };
      save();
    }
    const after = await client.getStickerSet(name);
    const added = (after?.stickers ?? []).filter((s) => !seen.has(s.file_unique_id)).pop();
    if (!added) throw new Error('这张已经在贴纸包里了');
    return added;
  }

  async function uploadConverted(buffer) {
    const converted = await convert(buffer);
    const file = await client.uploadStickerFile(ownerId, converted.buffer, converted.format);
    return { fileId: file.file_id, format: converted.format };
  }

  return {
    names,
    get store() { return store; },
    reload() { store = loadTgStickerStore(storeFile); },

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
     * source：{ sticker: { fileId, fileUniqueId, format, emoji, thumbFileId } } 收到的贴纸，原样进包（不用重新上传）；
     *         { image: Buffer } 图片，先转成贴纸规格再上传。
     */
    collect(source, note = '') {
      return serial(async () => {
        const srcId = source.sticker?.fileUniqueId;
        if (srcId && store.favorites.some((f) => f.fileUniqueId === srcId || f.sourceUniqueId === srcId)) {
          throw new Error('这张已经收藏过了');
        }
        let input;
        let emoji;
        if (source.sticker) {
          emoji = emojiListFor([source.sticker.emoji, note], defaultEmoji);
          input = { sticker: source.sticker.fileId, format: source.sticker.format, emoji_list: emoji, keywords: keywordsFor([note]) };
        } else {
          const up = await uploadConverted(source.image);
          emoji = emojiListFor([note], defaultEmoji);
          input = { sticker: up.fileId, format: up.format, emoji_list: emoji, keywords: keywordsFor([note]) };
        }
        const added = await addToSet('fav', input);
        const fav = cleanFavorite({
          fileId: added.file_id,
          fileUniqueId: added.file_unique_id,
          format: added.is_video ? 'video' : added.is_animated ? 'animated' : 'static',
          emoji: emoji[0],
          note,
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
      f.note = String(note ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').slice(0, 60);
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
     * 一次最多处理 maxAdds 张，避免启动时一口气打满 Telegram 限流；用得多的先同步。
     * @param {Array<{md5: string, desc?: string, localNote?: string, tags?: string[], useCount?: number}>} entries
     * @param {(entry: object) => Promise<Buffer>} download
     */
    syncQq(entries, download, { maxAdds = 20, gapMs = 1500 } = {}) {
      return serial(async () => {
        const result = { added: 0, removed: 0, failed: 0, skipped: 0 };
        const present = (Array.isArray(entries) ? entries : [])
          .filter((e) => /^[0-9A-F]{32}$/.test(String(e?.md5 ?? '').toUpperCase()));
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
            if (!/STICKER_INVALID|not found/i.test(String(error?.message))) { result.failed += 1; log(`[tg-sticker] 删除同步贴纸失败：${error?.message ?? error}`); continue; }
          }
          delete store.qq[md5];
          result.removed += 1;
          save();
        }
        for (const e of wanted) {
          const md5 = e.md5.toUpperCase();
          if (store.qq[md5]) continue;
          if (result.added >= maxAdds) { result.skipped += 1; continue; }
          try {
            const buf = await download(e);
            const up = await uploadConverted(buf);
            const texts = [e.desc, e.localNote, ...(e.tags || [])];
            const added = await addToSet('qq', { sticker: up.fileId, format: up.format, emoji_list: emojiListFor(texts, defaultEmoji), keywords: keywordsFor(texts) });
            store.qq[md5] = { fileId: added.file_id, fileUniqueId: added.file_unique_id, format: up.format, syncedAt: Date.now() };
            save();
            result.added += 1;
            if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
          } catch (error) {
            result.failed += 1;
            log(`[tg-sticker] 同步 QQ 表情 ${md5.slice(0, 8)} 失败：${error?.message ?? error}`);
            if (/已满/.test(String(error?.message))) break;
            if (error?.code === 429) break; // 被限流就留到下一轮
          }
        }
        return result;
      });
    }
  };
}
