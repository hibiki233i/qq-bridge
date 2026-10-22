#!/usr/bin/env node
// 连接配置 GUI：在桥接启动**之前**改 config.json 里「连得上」的那几项，并能当场测试连接。
//
// 为什么单独做一个：控制台（consolePort）是桥接跑起来以后才有的，而桥接要先连上 QQ 网关和 DSH
// 才跑得起来 —— 网关地址 / token / DSH 地址填错了，控制台根本打不开。这个页面不依赖桥接。
//
// 用法：
//   npm run config                      # 打开浏览器
//   node scripts/config-gui.mjs --no-open --port 3199 --config /path/config.json
//
// 安全：
//   - 只监听 127.0.0.1；校验 Host 头（防 DNS rebinding）
//   - 每次启动生成一次性令牌，写在打开的 URL 里；所有 /api/* 都要带 x-config-token
//   - 只改下面列出的字段，其余原样保留；写之前备份成 config.json.bak，写入用临时文件 + rename，权限 600
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TelegramClient } from '../src/telegram.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const PAGE = path.join(REPO, 'public', 'config-gui.html');

const argv = process.argv.slice(2);
const argOf = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const CONFIG = path.resolve(argOf('--config') || path.join(REPO, 'config.json'));
const ROOT = path.dirname(CONFIG);
const EXAMPLE = path.join(REPO, 'config.example.json');
const PORT = Number(argOf('--port') || 0);
const NO_OPEN = argv.includes('--no-open');
const TOKEN = crypto.randomBytes(16).toString('hex');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, ''));

// ── 读 / 写 config.json ─────────────────────────────────────────────────
function loadFile() {
  if (fs.existsSync(CONFIG)) return { file: readJson(CONFIG), isNew: false };
  return { file: fs.existsSync(EXAMPLE) ? readJson(EXAMPLE) : {}, isNew: true };
}

function bridgeRunning() {
  try {
    const pid = Number(fs.readFileSync(path.join(ROOT, 'state', 'bridge.lock'), 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** config.json → 页面上的表单（只取这几项） */
export function toForm(file) {
  const s = file.snowluma ?? {};
  const d = file.dsh ?? {};
  return {
    gateway: {
      impl: s.impl === 'napcat' || s.impl === 'snowluma' ? s.impl : 'auto',
      wsUrl: s.wsUrl ?? 'ws://127.0.0.1:3001',
      httpUrl: s.httpUrl ?? 'http://127.0.0.1:3000',
      accessToken: String(s.accessToken ?? ''),
      followDiscoveredEndpoint: s.followDiscoveredEndpoint !== false
    },
    dsh: { baseUrl: d.baseUrl ?? 'http://127.0.0.1:3080', authToken: d.authToken ?? '' },
    ownerQQ: file.ownerQQ == null ? '' : String(file.ownerQQ),
    allowPrivate: (file.allow?.private ?? []).map(String),
    allowGroups: (file.allow?.groups ?? []).map(String),
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    telegram: {
      enabled: file.telegram?.enabled === true,
      botToken: String(file.telegram?.botToken ?? ''),
      proxy: String(file.telegram?.proxy ?? ''),
      ownerId: file.telegram?.ownerId == null ? '' : String(file.telegram.ownerId),
      allowPrivate: (file.telegram?.allow?.private ?? []).map(String),
      allowGroups: (file.telegram?.allow?.groups ?? []).map(String),
      stickerFavorites: file.telegram?.stickers?.favorites === true,
      stickerSyncQQ: file.telegram?.stickers?.syncQQ === true
    }
  };
}

const TG_TOKEN_RE = /^\d{5,}:[A-Za-z0-9_-]{30,}$/;

/** Telegram id：用户是正数，群是负数（超级群形如 -100…）。 */
function checkTgIds(list, label, errors, { allowNegative }) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw).trim();
    if (!s) continue;
    const n = Number(s);
    if (!/^-?\d{1,16}$/.test(s) || !Number.isSafeInteger(n) || n === 0 || (n < 0 && !allowNegative)) {
      errors.push(`${label} 里的「${s}」不像 Telegram ${allowNegative ? '群 id（一般是 -100 开头的负数）' : '用户 id（正整数）'}`);
      continue;
    }
    if (!out.includes(n)) out.push(n);
  }
  return out;
}

function checkUrl(value, protocols, label, errors) {
  const s = String(value ?? '').trim();
  try {
    const u = new URL(s);
    if (!protocols.includes(u.protocol)) errors.push(`${label} 要以 ${protocols.map((p) => p + '//').join(' 或 ')} 开头`);
  } catch {
    errors.push(`${label} 不是合法地址：${s || '（空）'}`);
  }
  return s.replace(/\/+$/, '');
}

function checkIds(list, label, errors) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const s = String(raw).trim();
    if (!s) continue;
    if (!/^\d{5,12}$/.test(s)) { errors.push(`${label} 里的「${s}」不像 QQ 号/群号`); continue; }
    if (!out.includes(Number(s))) out.push(Number(s));
  }
  return out;
}

/** 表单 → 合并回完整 config（其余字段原样保留）。返回 { file } 或 { errors } */
export function applyForm(file, form) {
  const errors = [];
  const g = form?.gateway ?? {};
  const d = form?.dsh ?? {};
  const wsUrl = checkUrl(g.wsUrl, ['ws:', 'wss:'], 'WebSocket 地址', errors);
  const httpUrl = checkUrl(g.httpUrl, ['http:', 'https:'], 'HTTP 地址', errors);
  const baseUrl = checkUrl(d.baseUrl, ['http:', 'https:'], 'DSH 地址', errors);
  const impl = g.impl === 'napcat' || g.impl === 'snowluma' ? g.impl : 'auto';
  const owner = String(form?.ownerQQ ?? '').trim();
  if (owner && !/^\d{5,12}$/.test(owner)) errors.push(`管理员 QQ「${owner}」不像 QQ 号`);
  const allowPrivate = checkIds(form?.allowPrivate, '私聊白名单', errors);
  const allowGroups = checkIds(form?.allowGroups, '群白名单', errors);
  const t = form?.telegram ?? {};
  const tgEnabled = t.enabled === true;
  const botToken = String(t.botToken ?? '').trim();
  if (botToken && !TG_TOKEN_RE.test(botToken)) errors.push('Telegram Bot token 格式不对（应形如 123456789:AA…，找 @BotFather 要）');
  if (tgEnabled && !botToken) errors.push('启用 Telegram 需要填 Bot token');
  const proxyRaw = String(t.proxy ?? '').trim();
  const proxy = proxyRaw ? checkUrl(proxyRaw, ['http:'], 'Telegram 代理', errors) : '';
  const tgOwnerList = checkTgIds([t.ownerId ?? ''], 'Telegram 管理员', errors, { allowNegative: false });
  const tgAllowPrivate = checkTgIds(t.allowPrivate, 'Telegram 私聊白名单', errors, { allowNegative: false });
  const tgAllowGroups = checkTgIds(t.allowGroups, 'Telegram 群白名单', errors, { allowNegative: true });
  if (errors.length) return { errors };

  const next = structuredClone(file);
  const snowluma = { ...(next.snowluma ?? {}), wsUrl, httpUrl, accessToken: String(g.accessToken ?? '').trim(), followDiscoveredEndpoint: g.followDiscoveredEndpoint !== false };
  if (impl === 'auto') delete snowluma.impl; else snowluma.impl = impl;
  next.snowluma = snowluma;
  next.dsh = { ...(next.dsh ?? {}), baseUrl, authToken: String(d.authToken ?? '').trim() };
  next.ownerQQ = owner ? Number(owner) : null;
  next.allow = { ...(next.allow ?? {}), private: allowPrivate, groups: allowGroups };
  // 原文件里写着 false 就保留 false；本来没有这个键、也没勾选，就别凭空加一个
  if (form?.allowAllWhenEmpty === true) next.allowAllWhenEmpty = true;
  else if ('allowAllWhenEmpty' in next) next.allowAllWhenEmpty = false;
  // 原来没有 telegram 段、这次也什么都没填，就别凭空加一段
  const tgTouched = tgEnabled || botToken || proxy || tgOwnerList.length || tgAllowPrivate.length || tgAllowGroups.length;
  if ('telegram' in next || tgTouched) {
    const prev = next.telegram ?? {};
    next.telegram = {
      ...prev,
      enabled: tgEnabled,
      botToken,
      proxy,
      ownerId: tgOwnerList[0] ?? null,
      allow: { ...(prev.allow ?? {}), private: tgAllowPrivate, groups: tgAllowGroups },
      stickers: { ...(prev.stickers ?? {}), favorites: t.stickerFavorites === true, syncQQ: t.stickerSyncQQ === true }
    };
  }
  return { file: next };
}

function saveFile(file) {
  let backup = null;
  if (fs.existsSync(CONFIG)) {
    backup = CONFIG + '.bak';
    fs.copyFileSync(CONFIG, backup);
    try { fs.chmodSync(backup, 0o600); } catch {}
  }
  const tmp = `${CONFIG}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, CONFIG);
  return backup;
}

// ── 连接测试 ─────────────────────────────────────────────────────────────
// fetch 的底层错误码可能在 cause 上，也可能在 cause.errors[]（localhost 同时试 IPv4/IPv6 时）
const netCode = (error) => error?.cause?.code || error?.cause?.errors?.[0]?.code || '';
const isLoopback = (u) => { try { return ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(new URL(u).hostname); } catch { return false; } };

async function onebotHttp(httpUrl, token, action) {
  const res = await fetch(`${String(httpUrl).replace(/\/+$/, '')}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: '{}',
    signal: AbortSignal.timeout(5000)
  });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

async function testHttp(httpUrl, token) {
  try {
    const v = await onebotHttp(httpUrl, token, 'get_version_info');
    if (v.status === 401 || v.status === 403 || v.body?.retcode === 1403) return { ok: false, error: `token 不对（HTTP ${v.status}）` };
    if (v.status === 426) return { ok: false, error: 'HTTP 426：这个端口是 WebSocket，不是 HTTP 服务' };
    if (!v.body || v.body.status !== 'ok') return { ok: false, error: `网关有响应但不像 OneBot（HTTP ${v.status}）` };
    const app = v.body.data ?? {};
    const login = await onebotHttp(httpUrl, token, 'get_login_info').catch(() => null);
    const me = login?.body?.status === 'ok' ? login.body.data : null;
    const name = String(app.app_name ?? '').toLowerCase();
    return {
      ok: true,
      app: `${app.app_name ?? '未知'} ${app.app_version ?? ''}`.trim(),
      impl: name.includes('napcat') ? 'napcat' : name.includes('snowluma') ? 'snowluma' : 'unknown',
      login: me ? `${me.nickname ?? ''}（${me.user_id}）` : null
    };
  } catch (error) {
    const msg = error?.name === 'TimeoutError' ? '5 秒没响应' : (netCode(error) === 'ECONNREFUSED' ? '连接被拒绝：这个端口没人在听' : (netCode(error) || error?.cause?.message || error?.message || String(error)));
    return { ok: false, error: msg };
  }
}

function testWs(wsUrl, token) {
  return new Promise((resolve) => {
    let done = false;
    let ws;
    const finish = (r) => { if (done) return; done = true; clearTimeout(timer); try { ws?.close(); } catch {} resolve(r); };
    const timer = setTimeout(() => finish({ ok: false, error: '5 秒没连上' }), 5000);
    try {
      const u = new URL(wsUrl);
      if (token) u.searchParams.set('access_token', token);
      ws = new WebSocket(u);
    } catch (error) {
      return finish({ ok: false, error: error?.message ?? String(error) });
    }
    const echo = 'cfg-gui-' + Date.now();
    ws.addEventListener('open', () => ws.send(JSON.stringify({ action: 'get_login_info', params: {}, echo })));
    ws.addEventListener('message', (ev) => {
      let msg = null;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg?.echo !== echo) return; // 连上后先推的是 lifecycle/heartbeat 事件，等自己那条回包
      if (msg.retcode === 1403 || msg.retcode === 1401) finish({ ok: false, error: 'token 不对' });
      else if (msg.status === 'ok') finish({ ok: true, login: msg.data ? `${msg.data.nickname ?? ''}（${msg.data.user_id}）` : null });
      else finish({ ok: false, error: `网关回了 ${msg.retcode ?? '?'}：${msg.wording || msg.message || ''}` });
    });
    ws.addEventListener('error', () => finish({ ok: false, error: '连不上（端口没人听，或握手被拒：多半是 token 不对）' }));
    ws.addEventListener('close', (ev) => finish({ ok: false, error: `连接被关闭（code ${ev.code}${ev.reason ? '：' + ev.reason : ''}）` }));
  });
}

async function testDsh(baseUrl) {
  try {
    const res = await fetch(String(baseUrl).replace(/\/+$/, '') + '/', { signal: AbortSignal.timeout(4000) });
    return { ok: true, status: res.status };
  } catch (error) {
    const msg = error?.name === 'TimeoutError' ? '4 秒没响应' : (netCode(error) === 'ECONNREFUSED' ? '连接被拒绝：DSH 没开，或者端口不对' : (netCode(error) || error?.cause?.message || error?.message || String(error)));
    return { ok: false, error: msg };
  }
}

async function testTelegram({ botToken, proxy }, apiBase) {
  const token = String(botToken ?? '').trim();
  if (!TG_TOKEN_RE.test(token)) return { ok: false, error: 'Bot token 格式不对（应形如 123456789:AA…）' };
  const p = String(proxy ?? '').trim();
  if (p) {
    try { if (new URL(p).protocol !== 'http:') return { ok: false, error: '代理只支持 http:// 开头的 HTTP 代理' }; }
    catch { return { ok: false, error: `代理地址不合法：${p}` }; }
  }
  const client = new TelegramClient({ botToken: token, apiBase: apiBase || undefined, proxy: p });
  try {
    const me = await client.call('getMe', {}, { timeoutMs: 10000 });
    let webhook = false;
    try { webhook = !!(await client.call('getWebhookInfo', {}, { timeoutMs: 10000 }))?.url; } catch {}
    return {
      ok: true,
      bot: `@${me.username ?? '?'}（${me.first_name ?? ''}）`,
      readsAllGroupMessages: me.can_read_all_group_messages === true,
      webhook
    };
  } catch (error) {
    if (error?.code === 401 || error?.code === 404) return { ok: false, error: 'token 无效（Telegram 不认）' };
    if (error?.code === 'network') return { ok: false, error: `连不上 Telegram${p ? '（代理是否开着？）' : '：国内要填代理'}`, detail: error.message };
    return { ok: false, error: error?.message ?? String(error) };
  }
}

// ── HTTP 服务 ────────────────────────────────────────────────────────────
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 256 * 1024) { reject(new Error('请求太大')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('不是合法 JSON')); } });
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const port = server.address().port;
  if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) return send(res, 403, { error: 'bad host' });
  const url = new URL(req.url, `http://127.0.0.1:${port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/') {
      return send(res, 200, fs.readFileSync(PAGE, 'utf8'), 'text/html; charset=utf-8');
    }
    if (!url.pathname.startsWith('/api/')) return send(res, 404, { error: 'not found' });
    const given = Buffer.from(String(req.headers['x-config-token'] ?? ''));
    if (given.length !== TOKEN.length || !crypto.timingSafeEqual(given, Buffer.from(TOKEN))) return send(res, 403, { error: '令牌不对：请用命令行打印的完整地址打开' });

    if (req.method === 'GET' && url.pathname === '/api/config') {
      const { file, isNew } = loadFile();
      return send(res, 200, { form: toForm(file), isNew, configPath: CONFIG, bridgeRunning: bridgeRunning(), consolePort: file.consolePort ?? 3100 });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const form = await readBody(req);
      const { file } = loadFile();
      const r = applyForm(file, form);
      if (r.errors) return send(res, 400, { errors: r.errors });
      const backup = saveFile(r.file);
      return send(res, 200, { ok: true, configPath: CONFIG, backup, bridgeRunning: bridgeRunning() });
    }
    if (req.method === 'POST' && url.pathname === '/api/test/gateway') {
      const b = await readBody(req);
      const [httpR, wsR] = await Promise.all([testHttp(b.httpUrl, b.accessToken), testWs(b.wsUrl, b.accessToken)]);
      return send(res, 200, { http: httpR, ws: wsR, remote: !isLoopback(b.httpUrl) || !isLoopback(b.wsUrl) });
    }
    if (req.method === 'POST' && url.pathname === '/api/test/dsh') {
      const b = await readBody(req);
      return send(res, 200, { ...(await testDsh(b.baseUrl)), remote: !isLoopback(b.baseUrl) });
    }
    if (req.method === 'POST' && url.pathname === '/api/test/telegram') {
      const b = await readBody(req);
      return send(res, 200, await testTelegram(b, loadFile().file.telegram?.apiBase));
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      send(res, 200, { ok: true });
      setTimeout(() => { console.log('配置页已关闭。'); process.exit(0); }, 100);
      return;
    }
    return send(res, 404, { error: 'not found' });
  } catch (error) {
    return send(res, 500, { error: error?.message ?? String(error) });
  }
});

function openBrowser(target) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [target]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', target]]
    : ['xdg-open', [target]];
  try { spawn(cmd, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref(); } catch {}
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  server.listen(PORT, '127.0.0.1', () => {
    const target = `http://127.0.0.1:${server.address().port}/#t=${TOKEN}`;
    console.log('\n  qq-bridge 连接配置');
    console.log(`  配置文件：${CONFIG}${fs.existsSync(CONFIG) ? '' : '（还没有，保存时新建）'}`);
    console.log(`  打开：${target}`);
    console.log('  （这个地址带一次性令牌，只在本机有效；关掉这个窗口或按 Ctrl+C 就停）\n');
    if (!NO_OPEN) openBrowser(target);
  });
}
