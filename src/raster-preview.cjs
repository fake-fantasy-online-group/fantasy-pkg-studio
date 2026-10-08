'use strict';

const { PNG } = require('pngjs');

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MASK_HEADER_SIZE = 62;
const MASK_MAX_POINTS = 1_000_000;
const TIL_IMAGE_BYTES = 128 * 128 * 4;
const TIL_ATLAS_COLUMNS = 3;
const TIL_ATLAS_ROWS = 5;
const TEXT_PAGE_SIZE = 100;

function checkedPage(page) {
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('栅格预览页码必须是非负安全整数');
  return page;
}

function pngResult(data, name, width, height, page, pageCount, info) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1 ||
      width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS ||
      data.length !== width * height * 4) {
    throw new Error(`${name}图像尺寸超过预览安全上限`);
  }
  const png = PNG.sync.write({ width, height, data });
  return {
    kind: 'image',
    mime: 'image/png',
    base64: png.toString('base64'),
    width,
    height,
    page,
    pageCount,
    info,
  };
}

function nameExtension(name) {
  return /\.([^.\\/]+)$/.exec(String(name || ''))?.[1]?.toLowerCase() || '';
}

function makeMaskPreview(buffer, page) {
  if (buffer.length < 8 || buffer.readInt32LE(0) !== -1 || buffer.readInt32LE(4) !== 0x10002) return null;
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('.mask 超过 64 MiB 读取上限');
  if (buffer.length < MASK_HEADER_SIZE) throw new Error('.mask 的58字节头和数量字段不完整');
  for (let offset = 8; offset < 58; offset += 1) {
    if (buffer[offset] !== 0) throw new Error('.mask 头部保留区不符合已确认的58字节格式');
  }

  const count = buffer.readInt32LE(58);
  if (count < 0 || count > MASK_MAX_POINTS || MASK_HEADER_SIZE + 9 * count !== buffer.length) {
    throw new Error('.mask 物件足迹数量或文件长度无效');
  }
  if (count === 0) {
    if (page !== 0) throw new Error('.mask 空物件足迹只有第 1 页');
    return {
      kind: 'text',
      text: '(无物件足迹坐标)',
      page: 0,
      pageCount: 1,
      info: '.mask 空物件足迹；count=0。此文件记录物件足迹坐标，不是地图移动碰撞数据。',
    };
  }

  const flagsStart = MASK_HEADER_SIZE + count * 8;
  let maxX = 0;
  let maxY = 0;
  let supportedFlags = true;
  for (let index = 0; index < count; index += 1) {
    const x = buffer.readInt32LE(MASK_HEADER_SIZE + index * 8);
    const y = buffer.readInt32LE(MASK_HEADER_SIZE + index * 8 + 4);
    const flags = buffer[flagsStart + index];
    if (x < 5 || y < 5 || x > 100000 || y > 100000 || x % 10 !== 5 || y % 10 !== 5) {
      throw new Error(`.mask 第 ${index + 1} 个物件足迹坐标不符合10单位格中心格式`);
    }
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    if (flags !== 0x81) supportedFlags = false;
  }

  if (!supportedFlags) {
    const pageCount = Math.ceil(count / TEXT_PAGE_SIZE);
    if (page >= pageCount) throw new Error(`.mask 文本页超出范围（共 ${pageCount} 页）`);
    const first = page * TEXT_PAGE_SIZE;
    const lines = ['x\ty\tflags'];
    for (let index = first; index < Math.min(count, first + TEXT_PAGE_SIZE); index += 1) {
      const offset = MASK_HEADER_SIZE + index * 8;
      lines.push(`${buffer.readInt32LE(offset)}\t${buffer.readInt32LE(offset + 4)}\t0x${buffer[flagsStart + index].toString(16).padStart(2, '0')}`);
    }
    return {
      kind: 'text',
      text: lines.join('\n'),
      page,
      pageCount,
      info: `.mask 有 ${count} 个物件足迹坐标；包含未确认 flags，仅显示原值，不推测flag语义。`,
    };
  }

  const width = Math.floor(maxX / 10) + 1;
  const height = Math.floor(maxY / 10) + 1;
  if (width * height > MAX_PIXELS || width > MAX_DIMENSION || height > MAX_DIMENSION) {
    const pageCount = Math.ceil(count / TEXT_PAGE_SIZE);
    if (page >= pageCount) throw new Error(`.mask 坐标文本页超出范围（共 ${pageCount} 页）`);
    const first = page * TEXT_PAGE_SIZE;
    const lines = ['x\ty\tflags'];
    for (let index = first; index < Math.min(count, first + TEXT_PAGE_SIZE); index += 1) {
      const offset = MASK_HEADER_SIZE + index * 8;
      lines.push(`${buffer.readInt32LE(offset)}\t${buffer.readInt32LE(offset + 4)}\t0x${buffer[flagsStart + index].toString(16).padStart(2, '0')}`);
    }
    return {
      kind: 'text',
      text: lines.join('\n'),
      page,
      pageCount,
      info: `.mask 有 ${count} 个物件足迹坐标，坐标范围 ${width}×${height} 超过图像预览上限；按原始坐标分页显示，0x81保留为原始flag值。`,
    };
  }
  if (page !== 0) throw new Error('.mask 物件足迹图只有第 1 页');

  const pixels = Buffer.alloc(width * height * 4);
  for (let index = 0; index < count; index += 1) {
    const coordinateOffset = MASK_HEADER_SIZE + index * 8;
    const px = Math.floor(buffer.readInt32LE(coordinateOffset) / 10);
    const py = Math.floor(buffer.readInt32LE(coordinateOffset + 4) / 10);
    const offset = (py * width + px) * 4;
    pixels[offset] = 235;
    pixels[offset + 1] = 74;
    pixels[offset + 2] = 74;
    pixels[offset + 3] = 255;
  }
  return pngResult(pixels, '.mask', width, height, 0, 1,
    `.mask 物件足迹坐标预览；${count} 个点；像素对应10×10原始坐标单位；红点保留原始 x/y 位置；原始flag=0x81（未解释其遮挡语义）。`);
}

function writeTilImage(source, sourceOffset, destination, destinationWidth, destinationX, destinationY) {
  for (let y = 0; y < 128; y += 1) {
    // The game's texture upload applies FlipV before SetPixels32. Its visible
    // top row therefore corresponds to source row 0; PNG also stores its top
    // row first, so copying row-for-row avoids a second vertical flip.
    const sourceY = y;
    for (let x = 0; x < 128; x += 1) {
      const src = sourceOffset + (sourceY * 128 + x) * 4;
      const dest = ((destinationY + y) * destinationWidth + destinationX + x) * 4;
      destination[dest] = source[src + 2];
      destination[dest + 1] = source[src + 1];
      destination[dest + 2] = source[src];
      destination[dest + 3] = source[src + 3];
    }
  }
}

function makeTilPreview(buffer, page) {
  if (buffer.length < 4 || buffer.toString('ascii', 0, 4) !== 'ELIT') return null;
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('.til 超过 64 MiB 读取上限');
  if (buffer.length < 0x100) throw new Error('.til ELIT 索引区不完整');

  const format = buffer.readInt32LE(8);
  const total = buffer.readInt32LE(12);
  if (format < 0 || total <= 0) throw new Error('.til 格式版本或图像数量无效');
  const headerSize = format > 0x1002 ? 0x144 : 0x13c;
  if (buffer.length < headerSize || headerSize + total * TIL_IMAGE_BYTES > buffer.length) {
    throw new Error('.til 声明的128×128 BGRA图像超出文件边界');
  }

  if (format > 0x1002 && buffer.length >= 0x144) {
    const frameMs = buffer.readInt32LE(0x13c);
    const requestedFrames = buffer.readInt32LE(0x140);
    const frameCount = Math.min(requestedFrames, total);
    if (requestedFrames > 1 && frameMs > 0 && frameCount > 0 && headerSize + frameCount * TIL_IMAGE_BYTES <= buffer.length) {
      if (page >= frameCount) throw new Error(`.til 动画帧超出范围（共 ${frameCount} 帧）`);
      const pixels = Buffer.alloc(TIL_IMAGE_BYTES);
      writeTilImage(buffer, headerSize + page * TIL_IMAGE_BYTES, pixels, 128, 0, 0);
      return pngResult(pixels, '.til', 128, 128, page, frameCount,
        `.til ELIT 动画帧 ${page + 1}/${frameCount}；${frameMs} ms/帧；128×128 BGRA 原始帧。`);
    }
  }

  const pageCount = 1;
  if (page !== 0) throw new Error('.til 静态形状图集只有第 1 页');
  const indices = new Array(60);
  for (let index = 0; index < indices.length; index += 1) indices[index] = buffer.readInt32LE(0x10 + index * 4);
  const width = TIL_ATLAS_COLUMNS * 128;
  const height = TIL_ATLAS_ROWS * 128;
  const pixels = Buffer.alloc(width * height * 4);
  let missing = 0;
  for (let shape = 0; shape < 15; shape += 1) {
    // FloorRenderer consumes the first index from each four-index group.
    const imageIndex = indices[shape * 4];
    if (imageIndex < 0 || imageIndex >= total) {
      missing += 1;
      continue;
    }
    const x = (shape % TIL_ATLAS_COLUMNS) * 128;
    const y = Math.floor(shape / TIL_ATLAS_COLUMNS) * 128;
    writeTilImage(buffer, headerSize + imageIndex * TIL_IMAGE_BYTES, pixels, width, x, y);
  }
  return pngResult(pixels, '.til', width, height, page, pageCount,
    `.til ELIT 静态15形状图集；每组4个索引按 FloorRenderer 取首项；${total} 个128×128 BGRA图像；${missing} 个形状索引为空或越界。`);
}

function scale5(value) {
  return Math.round(value * 255 / 31);
}

function tgaColor(buffer, offset, depth, attributeBits) {
  if (depth === 8) {
    const gray = buffer[offset];
    return [gray, gray, gray, 255];
  }
  if (depth === 15 || depth === 16) {
    const value = buffer.readUInt16LE(offset);
    return [scale5((value >> 10) & 31), scale5((value >> 5) & 31), scale5(value & 31),
      depth === 16 && attributeBits >= 1 ? ((value & 0x8000) ? 255 : 0) : 255];
  }
  if (depth === 24) return [buffer[offset + 2], buffer[offset + 1], buffer[offset], 255];
  if (depth === 32) return [buffer[offset + 2], buffer[offset + 1], buffer[offset], attributeBits ? buffer[offset + 3] : 255];
  throw new Error(`不支持的 TGA 像素深度 ${depth}`);
}

function decodeTga(buffer) {
  if (buffer.length < 18) throw new Error('TGA 文件头不完整');
  const idLength = buffer[0];
  const colorMapType = buffer[1];
  const imageType = buffer[2];
  const mapFirst = buffer.readUInt16LE(3);
  const mapLength = buffer.readUInt16LE(5);
  const mapDepth = buffer[7];
  const width = buffer.readUInt16LE(12);
  const height = buffer.readUInt16LE(14);
  const pixelDepth = buffer[16];
  const descriptor = buffer[17];
  const attributeBits = descriptor & 0x0f;
  if (![1, 2, 3, 9, 10, 11].includes(imageType)) return null;
  if ((descriptor & 0xc0) !== 0) return null;
  if (colorMapType !== 0 && colorMapType !== 1) return null;
  if (width < 1 || height < 1 || width > MAX_DIMENSION || height > MAX_DIMENSION || width * height > MAX_PIXELS) {
    throw new Error(`TGA 图像尺寸 ${width}×${height} 超过预览上限`);
  }

  const isIndexed = imageType === 1 || imageType === 9;
  const isTrueColor = imageType === 2 || imageType === 10;
  const isGray = imageType === 3 || imageType === 11;
  const isRle = imageType === 9 || imageType === 10 || imageType === 11;
  if (isIndexed && (colorMapType !== 1 || mapLength < 1 || ![8, 16].includes(pixelDepth) || ![15, 16, 24, 32].includes(mapDepth))) return null;
  if (!isIndexed && colorMapType !== 0) return null;
  if (isTrueColor && ![15, 16, 24, 32].includes(pixelDepth)) return null;
  if (isGray && ![8, 16].includes(pixelDepth)) return null;
  if (pixelDepth === 15 && attributeBits !== 0) return null;
  if (isTrueColor && (pixelDepth === 15 || pixelDepth === 16) && attributeBits > 1) return null;
  if (pixelDepth === 32 && attributeBits !== 0 && attributeBits !== 8) return null;
  if (pixelDepth === 16 && isGray && attributeBits !== 0 && attributeBits !== 8) return null;

  let cursor = 18 + idLength;
  if (cursor > buffer.length) throw new Error('TGA 图像 ID 超出文件边界');
  const palette = [];
  if (isIndexed) {
    const paletteBytes = Math.ceil(mapDepth / 8);
    const paletteEnd = cursor + mapLength * paletteBytes;
    if (paletteEnd > buffer.length) throw new Error('TGA 调色板超出文件边界');
    for (let index = 0; index < mapLength; index += 1) {
      palette.push(tgaColor(buffer, cursor + index * paletteBytes, mapDepth, attributeBits));
    }
    cursor = paletteEnd;
  } else if (colorMapType === 1) {
    return null;
  }

  const pixelBytes = Math.ceil(pixelDepth / 8);
  const pixels = Buffer.alloc(width * height * 4);
  const topOrigin = (descriptor & 0x20) !== 0;
  const rightOrigin = (descriptor & 0x10) !== 0;
  let written = 0;
  const readPixel = () => {
    if (cursor + pixelBytes > buffer.length) throw new Error('TGA 像素数据在文件结束前被截断');
    let color;
    if (isIndexed) {
      const index = pixelDepth === 8 ? buffer[cursor] : buffer.readUInt16LE(cursor);
      if (index < mapFirst || index >= mapFirst + palette.length) throw new Error(`TGA 调色板索引 ${index} 超出声明范围`);
      color = palette[index - mapFirst];
    } else if (isGray && pixelDepth === 16) {
      const gray = buffer[cursor];
      color = [gray, gray, gray, attributeBits >= 8 ? buffer[cursor + 1] : 255];
    } else {
      color = tgaColor(buffer, cursor, pixelDepth, attributeBits);
    }
    cursor += pixelBytes;
    return color;
  };
  const putPixel = (color) => {
    const sourceY = Math.floor(written / width);
    const sourceX = written % width;
    const x = rightOrigin ? width - 1 - sourceX : sourceX;
    const y = topOrigin ? sourceY : height - 1 - sourceY;
    const offset = (y * width + x) * 4;
    pixels[offset] = color[0];
    pixels[offset + 1] = color[1];
    pixels[offset + 2] = color[2];
    pixels[offset + 3] = color[3];
    written += 1;
  };

  while (written < width * height) {
    if (!isRle) {
      putPixel(readPixel());
      continue;
    }
    if (cursor >= buffer.length) throw new Error('TGA RLE 数据包头被截断');
    const packet = buffer[cursor++];
    const runLength = (packet & 0x7f) + 1;
    if (written + runLength > width * height) throw new Error('TGA RLE 数据包超出图像像素范围');
    if (packet & 0x80) {
      const color = readPixel();
      for (let index = 0; index < runLength; index += 1) putPixel(color);
    } else {
      for (let index = 0; index < runLength; index += 1) putPixel(readPixel());
    }
  }
  return { width, height, pixels, imageType, pixelDepth, descriptor };
}

function makeTgaPreview(buffer, page) {
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('.tga 超过 64 MiB 读取上限');
  if (page !== 0) throw new Error('.tga 图像只有第 1 页');
  const decoded = decodeTga(buffer);
  if (!decoded) return null;
  const type = new Map([[1, '调色板未压缩'], [2, '真彩未压缩'], [3, '灰度未压缩'], [9, '调色板RLE'], [10, '真彩RLE'], [11, '灰度RLE']]).get(decoded.imageType);
  return pngResult(decoded.pixels, '.tga', decoded.width, decoded.height, 0, 1,
    `TGA ${type}像素图；${decoded.pixelDepth} bit；${decoded.width}×${decoded.height}；按原点方向还原；仅显示图像像素，不推断游戏用途。`);
}

function makeRasterPreview(buffer, name, { page = 0 } = {}) {
  const extension = nameExtension(name);
  if (!['mask', 'til', 'tga'].includes(extension) || !Buffer.isBuffer(buffer)) return null;
  checkedPage(page);
  if (buffer.length > MAX_INPUT_BYTES) throw new Error(`.${extension} 超过 64 MiB 读取上限`);
  if (extension === 'mask') return makeMaskPreview(buffer, page);
  if (extension === 'til') return makeTilPreview(buffer, page);
  return makeTgaPreview(buffer, page);
}

module.exports = { makeRasterPreview };
