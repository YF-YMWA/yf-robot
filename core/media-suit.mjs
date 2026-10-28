/**
 * 判断一张图适不适合当表情包。
 *
 * 用户的原话：「不是所有抓取图都适合做表情包」。
 * 确实 —— 从网页上抠下来的东西大部分是：
 *   · 横幅/Banner（超宽）
 *   · 文章配图（大尺寸横图）
 *   · 网站图标（几十像素的 logo）
 *   · 截图（带一堆小字）
 * 这些存进素材库，只会让她发出去时很奇怪。
 *
 * 这里只看**技术上能判断的**特征（格式、尺寸、比例、体积），不花 token：
 *   · 动图（GIF）最像表情包
 *   · 正方形或接近正方形（0.7~1.4）
 *   · 尺寸不能太小（看不清）也不能太大（发出去占满屏幕）
 *   · PNG 透明底优先（那多半是抠好的表情）
 *
 * 语义层面（画面是不是个表情）交给可选的视觉检查，不在这里做。
 */

/** 从图片头里读宽高（不依赖任何库）。读不出来返回 null。 */
export function imageDims(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;

  // PNG：IHDR 在固定位置
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), format: 'png' };
  }

  // GIF
  const head = buf.slice(0, 6).toString('ascii');
  if (head === 'GIF87a' || head === 'GIF89a') {
    return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8), format: 'gif' };
  }

  // JPEG：扫 SOF 段
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const marker = buf[i + 1];
      // SOF0..SOF15（跳过 C4/C8/CC，那几个不是尺寸段）
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5), format: 'jpeg' };
      }
      const len = buf.readUInt16BE(i + 2);
      i += 2 + len;
    }
    return null;
  }

  // WEBP
  if (buf.slice(8, 12).toString('ascii') === 'WEBP') {
    const fourcc = buf.slice(12, 16).toString('ascii');
    if (fourcc === 'VP8 ' && buf.length >= 30) {
      return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff, format: 'webp' };
    }
    if (fourcc === 'VP8L' && buf.length >= 25) {
      const b = buf.readUInt32LE(21);
      return { width: (b & 0x3fff) + 1, height: ((b >> 14) & 0x3fff) + 1, format: 'webp' };
    }
    return null;
  }

  return null;
}

/** 长宽比落在「像个方块」的范围里 */
function nearSquare(w, h) {
  /**
   * 0.45~3.0。
   *
   * 之前卡 0.65~1.55，把「长条表情包」全判成不合格 —— 但那种
   * 1116×387 的弹幕式表情包在微信里很常见，是用户真收藏的。
   * 现在只挡极端比例（横幅广告 279×68、2197×68 那种）。
   */
  const r = w / h;
  return r >= 0.45 && r <= 3.0;
}

/**
 * 这张图能不能当表情包。
 *
 * @param {Buffer} buf
 * @param {object} [opts]
 * @param {number} [opts.maxBytes]
 * @returns {{ok:boolean, reason?:string, width?:number, height?:number, format?:string}}
 */
export function suitableAsSticker(buf, opts = {}) {
  const maxBytes = opts.maxBytes ?? 2 * 1024 * 1024;
  if (!buf || buf.length < 512) return { ok: false, reason: '太小（可能是占位图）' };
  if (buf.length > maxBytes) return { ok: false, reason: `超过 ${Math.round(maxBytes / 1024)}KB` };

  const d = imageDims(buf);
  if (!d) return { ok: false, reason: '读不出尺寸' };

  const { width: w, height: h } = d;
  if (!w || !h) return { ok: false, reason: '尺寸异常' };

  // 图标级（几十像素）做表情包什么都看不清
  if (w < 80 || h < 80) return { ok: false, reason: `太小（${w}×${h}）`, ...d };

  // 太大：微信里发出去会占满屏
  if (w > 1500 || h > 1500) return { ok: false, reason: `太大（${w}×${h}）`, ...d };

  // 横幅/长图：不像表情（0.65~1.55 之外的都不像）
  if (!nearSquare(w, h)) {
    return { ok: false, reason: `不是方形（${w}×${h}）`, ...d };
  }

  return { ok: true, ...d };
}

/**
 * 至少得像张「能用的图」（给「图片素材」用，标准宽松些）。
 */
export function suitableAsImage(buf, opts = {}) {
  const maxBytes = opts.maxBytes ?? 5 * 1024 * 1024;
  if (!buf || buf.length < 1024) return { ok: false, reason: '太小' };
  if (buf.length > maxBytes) return { ok: false, reason: '太大' };

  const d = imageDims(buf);
  if (!d) return { ok: false, reason: '读不出尺寸' };

  const { width: w, height: h } = d;
  if (w < 200 || h < 200) return { ok: false, reason: `分辨率太低（${w}×${h}）`, ...d };
  if (w > 6000 || h > 6000) return { ok: false, reason: '尺寸离谱', ...d };

  return { ok: true, ...d };
}
