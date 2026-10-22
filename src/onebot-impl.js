// OneBot 网关实现识别：SnowLuma / NapCat 在少数扩展接口上命名和参数不一样。
//
// 目前只有「收藏表情」这一块需要分流（实测对照两边源码）：
//   - 改备注：SnowLuma 是 modify_custom_face { emoji_id, desc }；
//             NapCat 是 set_custom_face_desc { emoji_id(数字 emoId), res_id, md5, desc }。
//   - 收藏：  SnowLuma 的 add_custom_face 接受 base64://；
//             NapCat 的 add_custom_face 只认**本地文件路径**（直接 stat/readFile），且不回 emoji_id。
// 其余收发消息、拍一拍、历史记录等标准/通用扩展接口两边一致，不走这里。
//
// 识别方式：标准接口 get_version_info 的 app_name（NapCat 是 "NapCat.Onebot"）。
// 也可以在 config.json 里用 snowluma.impl 显式指定（"napcat" / "snowluma"），跳过探测。

/** config 里的 snowluma.impl → 'napcat' | 'snowluma' | 'auto' */
export function resolveImplSetting(value) {
  const s = String(value ?? '').trim().toLowerCase();
  return s === 'napcat' || s === 'snowluma' ? s : 'auto';
}

/** get_version_info 的 data → 'napcat' | 'snowluma' | 'unknown' */
export function detectImplFromVersion(data) {
  const name = String(data?.app_name ?? '').toLowerCase();
  if (name.includes('napcat')) return 'napcat';
  if (name.includes('snowluma')) return 'snowluma';
  return 'unknown';
}

/**
 * 改收藏表情备注的请求。unknown 按 SnowLuma 处理（保持原行为）。
 * NapCat 需要的 emoId / md5 原值来自 fetch_custom_face_detail，由 sticker-lib 存在 entry 上。
 */
export function buildFaceRemarkRequest(impl, entry, desc) {
  if (impl === 'napcat') {
    const emoId = Number(entry?.emoId);
    if (!Number.isFinite(emoId) || !entry?.resId) {
      throw new Error('这个表情缺少 NapCat 改备注需要的 emoId/resId，请先用 qq_list_stickers 刷新表情库');
    }
    return {
      action: 'set_custom_face_desc',
      params: { emoji_id: emoId, res_id: String(entry.resId), md5: String(entry.rawMd5 || entry.md5 || ''), desc }
    };
  }
  return { action: 'modify_custom_face', params: { emoji_id: entry.id, desc } };
}

/** 按文件头猜图片扩展名（NapCat 收藏表情要落成本地文件）。 */
export function sniffImageExt(buffer) {
  const b = buffer ?? Buffer.alloc(0);
  if (b.length >= 6 && b.subarray(0, 6).toString('latin1').startsWith('GIF8')) return 'gif';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpg';
  if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return 'png';
}
