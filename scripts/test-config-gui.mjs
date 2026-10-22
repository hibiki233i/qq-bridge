// 连接配置 GUI 自检：起一个真的 config-gui 进程（--no-open），对着临时 config.json 和一个假 OneBot 网关跑。
//   1) 纯函数：toForm / applyForm（校验、只改该改的字段）
//   2) 安全：令牌、Host 校验
//   3) 读 / 存（备份、权限、其余字段原样）
//   4) 测试连接：HTTP + WebSocket（含 token 错误）、DSH
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toForm, applyForm } from './config-gui.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## 纯函数');
{
  const file = { snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'x', silenceWarnMs: 600000 }, dsh: { baseUrl: 'http://127.0.0.1:3080', model: 'deepseek-flash' }, ownerQQ: 10001, allow: { private: [10001], groups: [] }, socialV2: { a: 1 } };
  const f = toForm(file);
  ok(f.gateway.impl === 'auto' && f.gateway.httpUrl === 'http://127.0.0.1:3000' && f.ownerQQ === '10001', 'toForm 缺省值与类型');
  const r = applyForm(file, { ...f, gateway: { ...f.gateway, impl: 'napcat', followDiscoveredEndpoint: false }, allowGroups: ['123456789', '123456789'] });
  ok(!r.errors && r.file.snowluma.impl === 'napcat' && r.file.snowluma.silenceWarnMs === 600000, '改 impl，snowluma 其余字段保留');
  ok(r.file.dsh.model === 'deepseek-flash' && r.file.socialV2.a === 1, '无关配置原样保留');
  ok(JSON.stringify(r.file.allow.groups) === '[123456789]', '群号去重并存成数字');
  ok(file.snowluma.impl === undefined, '不改动传入的原对象');
  const back = applyForm(r.file, { ...toForm(r.file), gateway: { ...toForm(r.file).gateway, impl: 'auto' } });
  ok(!('impl' in back.file.snowluma), '选「自动识别」时删掉 impl 字段');
  const bad = applyForm(file, { ...f, gateway: { ...f.gateway, wsUrl: 'http://x' }, ownerQQ: 'abc', allowPrivate: ['12'] });
  ok(bad.errors?.length === 3, `非法输入给出 3 条错误（实际 ${bad.errors?.length}）`);
  const cleared = applyForm(file, { ...f, ownerQQ: '' });
  ok(cleared.file.ownerQQ === null, '清空管理员 QQ 存成 null');
  ok(!('allowAllWhenEmpty' in cleared.file), '原来没有 allowAllWhenEmpty 时不凭空加');
  const keepFalse = applyForm({ ...file, allowAllWhenEmpty: false }, f);
  ok(keepFalse.file.allowAllWhenEmpty === false, '原来写着 false 就保留 false');
}

// ── 假 OneBot 网关：HTTP + 极简 WebSocket（只够握手和收发小文本帧）──────────
const GOOD = 'good-token';
function onebotReply(action, token) {
  if (token !== GOOD) return { status: 'failed', retcode: 1403, data: null, wording: 'token验证失败' };
  if (action === 'get_version_info') return { status: 'ok', retcode: 0, data: { app_name: 'NapCat.Onebot', app_version: '4.18.41' } };
  if (action === 'get_login_info') return { status: 'ok', retcode: 0, data: { user_id: 123456789, nickname: '小鲸鱼' } };
  return { status: 'failed', retcode: 1404, data: null };
}
function wsFrame(text) {
  const p = Buffer.from(text);
  const head = p.length < 126 ? Buffer.from([0x81, p.length]) : Buffer.from([0x81, 126, p.length >> 8, p.length & 255]);
  return Buffer.concat([head, p]);
}
function wsParse(buf) {
  let len = buf[1] & 127;
  let off = 2;
  if (len === 126) { len = buf.readUInt16BE(2); off = 4; }
  const mask = buf.subarray(off, off + 4);
  const data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
  for (let i = 0; i < data.length; i += 1) data[i] ^= mask[i % 4];
  return data.toString('utf8');
}
const gw = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; }).on('end', () => {
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const body = onebotReply(req.url.slice(1), token);
    res.writeHead(body.retcode === 1403 ? 403 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  });
});
gw.on('upgrade', (req, socket) => {
  const token = new URL(req.url, 'http://x').searchParams.get('access_token');
  const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
  socket.write(wsFrame(JSON.stringify({ post_type: 'meta_event', meta_event_type: 'lifecycle' }))); // 先推一条事件，GUI 要能跳过它
  socket.on('data', (buf) => {
    if ((buf[0] & 0x0f) !== 1) return;
    const msg = JSON.parse(wsParse(buf));
    socket.write(wsFrame(JSON.stringify({ ...onebotReply(msg.action, token), echo: msg.echo })));
  });
  socket.on('error', () => {});
});
await new Promise((r) => gw.listen(0, '127.0.0.1', r));
const GW_PORT = gw.address().port;
// 一个确定没人听的端口（端口 1 之类会被 fetch 当成 bad port 直接拦掉，测不到「没人听」）
const closedPort = await new Promise((r) => { const s = http.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const dsh = http.createServer((req, res) => { res.writeHead(404); res.end(); });
await new Promise((r) => dsh.listen(0, '127.0.0.1', r));

// ── 起 GUI ───────────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-gui-test-'));
const CFG = path.join(tmp, 'config.json');
fs.writeFileSync(CFG, JSON.stringify({ snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: 'old', silenceWarnMs: 1 }, dsh: { baseUrl: 'http://127.0.0.1:3080', model: 'm' }, ownerQQ: null, allow: { private: [], groups: [] }, consolePort: 3100, keepMe: { nested: true } }, null, 2));
const child = spawn(process.execPath, [path.join(__dirname, 'config-gui.mjs'), '--no-open', '--config', CFG], { stdio: ['ignore', 'pipe', 'inherit'] });
const startUrl = await new Promise((resolve, reject) => {
  let out = '';
  child.stdout.on('data', (d) => { out += d; const m = /http:\/\/127\.0\.0\.1:(\d+)\/#t=([0-9a-f]+)/.exec(out); if (m) resolve(m); });
  child.on('exit', () => reject(new Error('config-gui 提前退出')));
  setTimeout(() => reject(new Error('config-gui 没打印地址')), 5000);
});
const BASE = `http://127.0.0.1:${startUrl[1]}`;
const TOKEN = startUrl[2];
const call = (p, body, { token = TOKEN, host } = {}) => new Promise((resolve, reject) => {
  const data = body === undefined ? null : JSON.stringify(body);
  const req = http.request(BASE + p, { method: data ? 'POST' : 'GET', headers: { 'x-config-token': token, ...(host ? { host } : {}), ...(data ? { 'content-type': 'application/json' } : {}) } }, (res) => {
    let t = ''; res.on('data', (c) => { t += c; }).on('end', () => { let j = null; try { j = JSON.parse(t); } catch {} resolve({ status: res.statusCode, json: j, text: t }); });
  });
  req.on('error', reject);
  if (data) req.write(data);
  req.end();
});

try {
  console.log('## 安全');
  ok((await call('/', undefined, { token: '' })).text.includes('qq-bridge 连接配置'), '页面本身可以打开（不含数据）');
  ok((await call('/api/config', undefined, { token: 'nope' })).status === 403, '没有令牌读不到配置');
  ok((await call('/api/config', undefined, { host: 'evil.example:80' })).status === 403, 'Host 不是本机时拒绝（防 DNS rebinding）');

  console.log('## 读 / 存');
  const got = await call('/api/config');
  ok(got.status === 200 && got.json.form.gateway.accessToken === 'old' && got.json.isNew === false, '读出现有配置');
  const form = got.json.form;
  const bad = await call('/api/config', { ...form, ownerQQ: 'x' });
  ok(bad.status === 400 && bad.json.errors.length === 1, '非法输入不写文件，返回错误列表');
  const saved = await call('/api/config', { ...form, gateway: { ...form.gateway, impl: 'napcat', accessToken: GOOD, followDiscoveredEndpoint: false }, ownerQQ: '10001', allowPrivate: ['10001'] });
  ok(saved.status === 200 && saved.json.backup === CFG + '.bak', '保存成功并返回备份路径');
  const onDisk = JSON.parse(fs.readFileSync(CFG, 'utf8'));
  ok(onDisk.snowluma.impl === 'napcat' && onDisk.snowluma.accessToken === GOOD && onDisk.snowluma.silenceWarnMs === 1, '写入网关字段，snowluma 其余字段保留');
  ok(onDisk.keepMe?.nested === true && onDisk.dsh.model === 'm' && onDisk.consolePort === 3100, '无关字段原样保留');
  ok(onDisk.ownerQQ === 10001 && onDisk.allow.private[0] === 10001, 'QQ 号存成数字');
  ok(JSON.parse(fs.readFileSync(CFG + '.bak', 'utf8')).snowluma.accessToken === 'old', '备份是保存前的内容');
  if (process.platform !== 'win32') ok((fs.statSync(CFG).mode & 0o777) === 0o600, 'config.json 权限 600');
  ok(!fs.readdirSync(tmp).some((n) => n.includes('.tmp-')), '没有遗留临时文件');

  console.log('## 测试连接');
  const gwUrls = { wsUrl: `ws://127.0.0.1:${GW_PORT}`, httpUrl: `http://127.0.0.1:${GW_PORT}` };
  const good = (await call('/api/test/gateway', { ...gwUrls, accessToken: GOOD })).json;
  ok(good.http.ok && good.http.impl === 'napcat' && good.http.login.includes('123456789'), `HTTP 通，识别出 NapCat 和登录号（${good.http.app}）`);
  ok(good.ws.ok && good.ws.login.includes('小鲸鱼'), 'WebSocket 通（跳过先推的事件，拿到自己的回包）');
  const wrong = (await call('/api/test/gateway', { ...gwUrls, accessToken: 'bad' })).json;
  ok(!wrong.http.ok && /token/.test(wrong.http.error), `HTTP token 错误能认出来（${wrong.http.error}）`);
  ok(!wrong.ws.ok && /token/.test(wrong.ws.error), `WebSocket token 错误能认出来（${wrong.ws.error}）`);
  const down = (await call('/api/test/gateway', { wsUrl: `ws://127.0.0.1:${closedPort}`, httpUrl: `http://127.0.0.1:${closedPort}`, accessToken: '' })).json;
  ok(!down.http.ok && !down.ws.ok && /没人在听/.test(down.http.error), `端口没人听时报得清楚（${down.http.error}）`);
  const d1 = (await call('/api/test/dsh', { baseUrl: `http://127.0.0.1:${dsh.address().port}` })).json;
  ok(d1.ok && d1.status === 404 && d1.remote === false, 'DSH 有响应就算通');
  const d2 = (await call('/api/test/dsh', { baseUrl: `http://127.0.0.1:${closedPort}` })).json;
  ok(!d2.ok && /DSH 没开/.test(d2.error), 'DSH 没开时报得清楚');

  console.log('## 关闭');
  const exited = new Promise((r) => child.once('exit', r));
  ok((await call('/api/shutdown', {})).status === 200, '关闭接口');
  ok((await Promise.race([exited.then(() => true), new Promise((r) => setTimeout(() => r(false), 3000))])), '进程退出');
} finally {
  child.kill();
  gw.close(); dsh.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
