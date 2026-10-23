// 管理员私聊专用 preset（qq-chat-v2-owner，带操作安卓模拟器的手机工具）的会话选择：
// 只在二代仿真下、只给 private:<ownerQQ>（含「同一个人」的 Telegram 私聊），群聊和别人永远不用；
// DSH 里没有这个 preset 时退回二代 preset，绝不往权限更高的方向回退。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
let tests = 0;
async function test(name, run) {
  tests++;
  try { await run(); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const OWNER = 10001;
const ALL_PRESETS = ['standard', 'qq-chat', 'qq-chat-v2', 'qq-chat-v2-owner'];
const BOT_TOKEN = '123456:' + 'A'.repeat(35);
const config = (ownerPhone) => ({
  ownerQQ: OWNER,
  agentPreset: 'qq-chat',
  socialV2: { agentPreset: 'qq-chat-v2', ...(ownerPhone === undefined ? {} : { ownerPhone }) },
  telegram: { enabled: true, botToken: BOT_TOKEN, ownerId: 111, links: [{ qq: OWNER, telegram: 111 }] },
});

async function withHarness(ownerPhone, run) {
  const h = await bridgeHarness({ config: config(ownerPhone) });
  try {
    h.setPresets(ALL_PRESETS);
    h.setMode('reserved2');
    await run(h);
  } finally { await h.close(); }
}

await test('二代仿真下只有管理员私聊用带手机的 preset', async () => {
  await withHarness({ enabled: true }, (h) => {
    const pick = (key) => h.modePreset(key, h.getMode(), h.cfg);
    assert.equal(pick(`private:${OWNER}`), 'qq-chat-v2-owner');
    assert.equal(pick('private:tg111'), 'qq-chat-v2-owner', '「同一个人」的 Telegram 私聊归到管理员 QQ 会话');
    assert.equal(pick('group:20002'), 'qq-chat-v2', '群聊不用');
    assert.equal(pick('private:30003'), 'qq-chat-v2', '别人的私聊不用');
    assert.equal(pick('private:tg222'), 'qq-chat-v2', '没关联的 Telegram 私聊不用');
    assert.equal(pick('group:tg-100500'), 'qq-chat-v2', 'Telegram 群不用');
  });
});

await test('其他模式不受影响', async () => {
  await withHarness({ enabled: true }, (h) => {
    assert.equal(h.modePreset(`private:${OWNER}`, 'chat', h.cfg), 'qq-chat', 'chat 模式照旧');
    assert.equal(h.modePreset(`private:${OWNER}`, 'reserved', h.cfg), 'qq-chat', '一代仿真照旧');
    assert.equal(h.modePreset(`private:${OWNER}`, 'closed-agent', h.cfg), 'standard', 'closed-agent 照旧用 DSH 默认 preset');
  });
});

await test('没开、或开了但 DSH 里没有这个 preset：用二代 preset', async () => {
  await withHarness(undefined, (h) => {
    assert.equal(h.modePreset(`private:${OWNER}`, 'reserved2', h.cfg), 'qq-chat-v2', '默认不开');
  });
  await withHarness({ enabled: 'true' }, (h) => {
    assert.equal(h.modePreset(`private:${OWNER}`, 'reserved2', h.cfg), 'qq-chat-v2', '只认 enabled: true');
  });
  await withHarness({ enabled: true }, (h) => {
    h.setPresets(['standard', 'qq-chat', 'qq-chat-v2']);
    assert.equal(h.modePreset(`private:${OWNER}`, 'reserved2', h.cfg), 'qq-chat-v2', '没跑 setup-dsh 时退回二代，不往高权限回退');
    h.setPresets([]);
    assert.equal(h.modePreset(`private:${OWNER}`, 'reserved2', h.cfg), undefined, 'DSH 清单未知时不建会话（和原来一样 fail-closed）');
  });
});

await test('开关一变，管理员私聊的会话策略跟着变（旧会话会被重建）', async () => {
  await withHarness({ enabled: true }, (h) => {
    const key = `private:${OWNER}`;
    const on = h.sessionPolicy(key);
    h.cfg.socialV2.ownerPhone.enabled = false;
    const off = h.sessionPolicy(key);
    assert.notEqual(on, off);
    assert.equal(h.sessionPolicy('group:20002'), JSON.stringify(['reserved2', 'qq-chat-v2', null]), '群聊策略不受影响');
  });
});

await test('管理员 preset 填给群聊 / 学习会话的配置项：拒绝', async () => {
  await withHarness({ enabled: true }, (h) => {
    h.cfg.socialV2.agentPreset = 'qq-chat-v2-owner';
    assert.equal(h.modePreset('group:20002', 'reserved2', h.cfg), undefined, '群聊建不出会话，也不会带上手机工具');
    assert.equal(h.modePreset('private:30003', 'reserved2', h.cfg), undefined);
    assert.equal(h.modePreset(`private:${OWNER}`, 'reserved2', h.cfg), 'qq-chat-v2-owner', '管理员私聊照常');
    assert.equal(h.resolvePresetName('qq-chat-v2-owner', { strict: true }), '');
  });
});

console.log(`\n${failures ? 'FAILED' : 'ALL PASS'}  tests=${tests} failures=${failures}`);
if (failures) process.exit(1);
