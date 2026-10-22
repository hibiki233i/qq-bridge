// 网关适配自检（SnowLuma / NapCat）：
// 1) onebot-impl 纯函数：识别网关、改备注请求、图片扩展名
// 2) sticker-lib 吃 NapCat 形状的 fetch_custom_face_detail（emoId/resId/md5），保留改备注需要的字段
import {
  resolveImplSetting,
  detectImplFromVersion,
  buildFaceRemarkRequest,
  sniffImageExt
} from '../src/onebot-impl.js';
import { mergeStickerLibrary, normalizeStickerEntry, findSticker } from '../src/sticker-lib.js';

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## 识别网关');
ok(resolveImplSetting('NapCat') === 'napcat', 'impl 配置大小写不敏感');
ok(resolveImplSetting('snowluma') === 'snowluma', 'impl=snowluma');
ok(resolveImplSetting('') === 'auto' && resolveImplSetting(undefined) === 'auto' && resolveImplSetting('lagrange') === 'auto', '未知/空值走自动探测');
ok(detectImplFromVersion({ app_name: 'NapCat.Onebot', app_version: '4.18.41' }) === 'napcat', 'NapCat 的 get_version_info');
ok(detectImplFromVersion({ app_name: 'SnowLuma' }) === 'snowluma', 'SnowLuma 的 get_version_info');
ok(detectImplFromVersion(null) === 'unknown', '没有 data 时 unknown');

console.log('## 改备注请求');
{
  const sl = buildFaceRemarkRequest('snowluma', { id: 'e1', resId: 'e1', md5: 'ABC' }, '笑死');
  ok(sl.action === 'modify_custom_face' && sl.params.emoji_id === 'e1' && sl.params.desc === '笑死', 'SnowLuma → modify_custom_face { emoji_id, desc }');
  const unk = buildFaceRemarkRequest('unknown', { id: 'e1' }, 'x');
  ok(unk.action === 'modify_custom_face', '识别不出时保持原行为（modify_custom_face）');
  const nc = buildFaceRemarkRequest('napcat', { id: 'r1', resId: 'r1', emoId: 7, md5: 'ABCD', rawMd5: 'abcd' }, '嘲讽');
  ok(nc.action === 'set_custom_face_desc', 'NapCat → set_custom_face_desc');
  ok(nc.params.emoji_id === 7 && nc.params.res_id === 'r1' && nc.params.md5 === 'abcd' && nc.params.desc === '嘲讽', 'NapCat 参数：数字 emoId + res_id + md5 原值 + desc');
  let threw = false;
  try { buildFaceRemarkRequest('napcat', { id: 'r1', resId: 'r1', md5: 'X' }, 'x'); } catch { threw = true; }
  ok(threw, 'NapCat 缺 emoId 时明确报错（而不是发出一个注定失败的请求）');
}

console.log('## 图片扩展名');
ok(sniffImageExt(Buffer.from('GIF89a....')) === 'gif', 'gif');
ok(sniffImageExt(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) === 'png', 'png');
ok(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff, 0xe0])) === 'jpg', 'jpg');
ok(sniffImageExt(Buffer.from('RIFF\0\0\0\0WEBPVP8 ')) === 'webp', 'webp');
ok(sniffImageExt(Buffer.alloc(0)) === 'png', '认不出来时按 png');

console.log('## sticker-lib × NapCat 表情列表');
{
  // NapCat fetch_custom_face_detail 的条目（NT 原样字段，节选）
  const napcatItems = [
    { emoId: 12, resId: 'res-a', md5: 'a1b2c3', url: 'https://x/a', desc: '狗头', emoPath: '/tmp/a' },
    { emoId: 13, resId: 'res-b', md5: 'D4E5F6', url: 'https://x/b', desc: '' }
  ];
  const lib = mergeStickerLibrary([], napcatItems);
  const a = findSticker(lib, 'res-a');
  ok(a && a.id === 'res-a' && a.resId === 'res-a', '没有 emoji_id 时用 resId 当 id');
  ok(a && a.emoId === 12 && a.rawMd5 === 'a1b2c3' && a.md5 === 'A1B2C3', '保留 emoId 和 md5 原值，md5 查找字段照旧大写');
  ok(findSticker(lib, 'A1B2C3')?.id === 'res-a', '按 md5 找得回来（收藏后认回刚加的那张）');
  const req = buildFaceRemarkRequest('napcat', a, '新备注');
  ok(req.params.emoji_id === 12 && req.params.res_id === 'res-a' && req.params.md5 === 'a1b2c3', '从库里的条目直接拼出 set_custom_face_desc');

  // 本地认知字段在二次同步后不丢，emoId 也不丢
  const noted = lib.map((e) => (e.id === 'res-a' ? { ...e, localNote: '他最爱用' } : e));
  const again = mergeStickerLibrary(noted, [{ resId: 'res-a', md5: 'a1b2c3', url: 'https://x/a', desc: '狗头' }]);
  const a2 = findSticker(again, 'res-a');
  ok(a2 && a2.localNote === '他最爱用' && a2.emoId === 12, '二次同步保留 localNote，缺 emoId 时沿用旧值');

  // SnowLuma 形状不受影响：没有 emoId 字段
  const sl = normalizeStickerEntry({ emoji_id: 'e1', resId: 'e1', md5: 'abc' });
  ok(sl && !('emoId' in sl) && !('rawMd5' in sl) && sl.md5 === 'ABC', 'SnowLuma 条目不多出 emoId/rawMd5');
  const persisted = normalizeStickerEntry(JSON.parse(JSON.stringify(a)));
  ok(persisted.emoId === 12 && persisted.rawMd5 === 'a1b2c3', '落盘再读回来字段还在');
}

console.log(`\n通过 ${pass} · 失败 ${fail}`);
process.exit(fail ? 1 : 0);
