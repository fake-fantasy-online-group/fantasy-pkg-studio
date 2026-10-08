'use strict';

const { PNG } = require('pngjs');
const { renderStaticFrame } = require('./dimg.cjs');
const { makeMapPreview } = require('./map-preview.cjs');

const MAX_OBJECTS = 10000;
const MAX_OBJECT_ASSETS = 128;
const MAX_RELATED_BYTES = 128 * 1024 * 1024;
const MAX_RELATED_FILE_BYTES = 64 * 1024 * 1024;
const MAX_OBJECT_IMAGE_PIXELS = 8 * 1024 * 1024;
const MAX_OBJECT_LAYER_PIXELS = 32 * 1024 * 1024;
const MAX_OBJECT_CACHE_BYTES = 16 * 1024 * 1024;
const MAX_MODERN_DRAWS = 250000;
const MAX_TILE_CACHE_BYTES = 32 * 1024 * 1024;

const OBJECT_GROUPS = new Map([
  [1, 'CC'], [2, 'CCP'], [3, 'GM'], [4, 'GMP'], [5, 'HP'], [6, 'HPP'],
  [7, 'HT'], [8, 'HTP'], [9, 'SM'], [10, 'SMP'], [11, 'LD'], [12, 'LDP'],
  [13, 'ZZ'], [14, 'ZZP'], [15, 'M'], [16, 'MP'], [17, 'DT'], [18, 'DTP'],
  [19, 'DX'], [20, 'DXP'], [21, 'TT'], [22, 'TTP'], [23, 'SK'], [24, 'SKP'],
  [25, 'ZW'], [26, 'ZWP'], [27, 'DD'], [28, 'DDP'], [29, 'HH'], [30, 'HHP'],
  [31, 'GT'], [32, 'GTP'], [33, 'MK'], [34, 'MKP'], [35, 'ZY'], [36, 'ZYP'],
  [37, 'SC'], [38, 'SCP'], [39, 'SW'], [40, 'SWP'], [41, 'LG'], [42, 'LGP'],
  [43, 'XJZ'], [44, 'XQQ'], [45, 'JZ'], [46, 'YB'], [47, 'YD'], [48, 'DH'],
  [49, 'YBCC'], [50, 'NT'], [51, 'QQ'], [52, 'JZP'], [53, 'QQP'], [54, 'XQP'],
  [55, 'NTP'], [56, 'DLP'], [57, 'CB'], [58, 'CBP'], [59, 'QM'], [60, 'BZ'],
  [61, 'BJWJ'], [62, 'BJDH'],
]);

const CITY_NAMES = new Map([
  [1, 'FY'], [2, 'XL'], [3, 'TD'], [4, 'TY'], [5, 'CL'], [6, 'DFYW'],
  [7, 'SW'], [8, 'YL'], [9, 'PL'], [10, 'TT'], [11, 'SJ'], [12, 'HJ'],
  [13, 'SMYW'], [14, 'HS'], [15, 'YM'], [16, 'GC'], [17, 'MY'], [18, 'TH'],
  [19, 'XFYW'], [20, 'TTD'], [21, 'YLD'], [22, 'PLSJ'], [23, 'SWS'], [24, 'DXWG'],
  [25, 'CLMG'], [26, 'TYMG'], [27, 'TJJ'], [28, 'JXMG'], [29, 'TJFB'], [30, 'JZSN'],
  [31, 'HYYSC'], [32, 'HYYHS'], [33, 'CLY'], [34, 'HDMZS'], [35, 'JLG'], [36, 'HSTX'],
  [37, 'SHLG'], [38, 'MC'], [39, 'ZHG'], [40, 'LHZC'],
]);

function readI32(bytes, offset, label) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > bytes.length) {
    throw new Error(`${label} 超出 GSM 文件边界`);
  }
  return bytes.readInt32LE(offset);
}

function checkedCount(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${label}数量超出安全范围`);
  return value;
}

function parseModernGsm(bytes) {
  const marker = bytes.indexOf(Buffer.from('PMIT', 'ascii'));
  if (marker < 0 || marker + 8 > bytes.length) return null;
  const reportedWidth = readI32(bytes, 0x60, 'PMIT reportedWidth');
  const reportedHeight = readI32(bytes, 0x64, 'PMIT reportedHeight');
  if (reportedWidth < 1 || reportedHeight < 1 || reportedWidth > 4095 || reportedHeight > 4095) {
    throw new Error('PMIT 网格尺寸无效');
  }
  let width = reportedWidth + 1;
  let height = reportedHeight + 1;
  const byteCount = readI32(bytes, marker + 4, 'PMIT byteCount');
  if (byteCount <= 0 || byteCount % 4 !== 0) throw new Error('PMIT 网格载荷长度无效');
  const count = byteCount / 4;
  if (count !== width * height) {
    if (count % height === 0) width = count / height;
    else if (count % width === 0) height = count / width;
  }
  if (!Number.isSafeInteger(width * height) || width < 1 || height < 1 || width * height !== count || count > 4 * 1024 * 1024) {
    throw new Error('PMIT 网格维度与载荷不匹配或超过安全上限');
  }
  const start = marker + 8;
  if (start + byteCount > bytes.length) throw new Error('PMIT 网格数据被截断');
  const grids = new Int32Array(count);
  for (let index = 0; index < count; index += 1) {
    const value = bytes.readUInt32LE(start + index * 4);
    grids[index] = value >= 1 && value <= 255 ? value << 8 : -1;
  }
  return { width, height, grids };
}

function modernCode(map, x, y) {
  if (x < 0 || y < 0 || x >= map.width || y >= map.height) return -1;
  const value = map.grids[x + map.width * y];
  if (value < 0) return -1;
  const encoded = value >>> 0;
  let code = (encoded >>> 8) & 0xff;
  if (code === 0) code = (encoded >>> 16) & 0x0f;
  if (code === 0) code = (encoded >>> 20) & 0xff;
  return code;
}

function parseTileNames(bytes) {
  if (!Buffer.isBuffer(bytes) || bytes.length > 8 * 1024 * 1024 || bytes.length % 2 !== 0) {
    throw new Error('tile.ini 缺失或超过8MiB/UTF-16LE边界');
  }
  const text = bytes.toString('utf16le').replace(/^\uFEFF/, '');
  const names = new Map();
  for (const row of text.split('\n')) {
    const line = row.trim();
    if (!/^\d{4}/.test(line)) continue;
    const name = line.slice(4).trim();
    if (name && name.length <= 128 && !/[\\/\x00-\x1f\x7f]/.test(name) && !name.includes('..')) {
      names.set(Number(line.slice(0, 4)), name);
    }
  }
  return names;
}

function decodeTilImage(bytes, offset) {
  const pixels = Buffer.alloc(128 * 128 * 4);
  for (let index = 0; index < 128 * 128; index += 1) {
    const source = offset + index * 4;
    const dest = index * 4;
    pixels[dest] = bytes[source + 2];
    pixels[dest + 1] = bytes[source + 1];
    pixels[dest + 2] = bytes[source];
    pixels[dest + 3] = bytes[source + 3];
  }
  return pixels;
}

function loadModernTile(bytes) {
  if (bytes.length < 0x13c || bytes.toString('ascii', 0, 4) !== 'ELIT') throw new Error('TIL 文件头或 ELIT 签名无效');
  const version = readI32(bytes, 8, 'TIL版本');
  const total = readI32(bytes, 12, 'TIL图像数量');
  const headerSize = version > 0x1002 ? 0x144 : 0x13c;
  if (version < 0 || total < 0 || total > 8192 || headerSize > bytes.length || headerSize + total * 65536 > bytes.length) {
    throw new Error('TIL 图像数量或像素载荷越界');
  }
  const indices = new Int32Array(60);
  for (let index = 0; index < 60; index += 1) indices[index] = readI32(bytes, 0x10 + index * 4, 'TIL形状索引');
  const shapes = new Array(15).fill(null);
  let cacheBytes = 0;
  for (let shape = 0; shape < 15; shape += 1) {
    const imageIndex = indices[shape * 4];
    if (imageIndex < 0 || imageIndex >= total) continue;
    shapes[shape] = decodeTilImage(bytes, headerSize + imageIndex * 65536);
    cacheBytes += shapes[shape].length;
  }
  let animation = null;
  if (version > 0x1002 && bytes.length >= 0x144) {
    const frameMs = readI32(bytes, 0x13c, 'TIL frameMs');
    const requestedFrames = readI32(bytes, 0x140, 'TIL frameCount');
    const frameCount = Math.min(requestedFrames, total);
    if (requestedFrames > 1 && frameMs > 0 && frameCount > 1 && headerSize + frameCount * 65536 <= bytes.length) {
      animation = { frameMs, frameCount, firstFrame: decodeTilImage(bytes, headerSize) };
      cacheBytes += animation.firstFrame.length;
    }
  }
  return { shapes, animation, cacheBytes };
}

async function renderModernGround(map, readRelated) {
  const rawWidth = map.width * 128;
  const rawHeight = map.height * 128;
  const scale = Math.max(1, Math.ceil(rawWidth / 2048), Math.ceil(rawHeight / 2048),
    Math.ceil(Math.sqrt((rawWidth * rawHeight) / (4 * 1024 * 1024))));
  const width = Math.ceil(rawWidth / scale);
  const height = Math.ceil(rawHeight / scale);
  if (width > 2048 || height > 2048 || width * height > 4 * 1024 * 1024) throw new Error('PMIT 地面图像超出像素上限');
  const image = new PNG({ width, height, colorType: 6 });
  let namesBytes = null;
  let codeNames = new Map();
  const tileIssues = [];
  try {
    namesBytes = await readRelated('tile/tile.ini');
    if (namesBytes) codeNames = parseTileNames(namesBytes);
    else tileIssues.push({ path: 'tile/tile.ini', reason: '缺少现代地面 code 到 TIL 名称的映射' });
  } catch (error) {
    tileIssues.push({ path: 'tile/tile.ini', reason: error.message });
  }
  if (!codeNames.has(0)) codeNames.set(0, '新手浅草');
  const cache = new Map();
  const rejectedTiles = new Set();
  const issuePaths = new Set();
  let cacheBytes = 0;
  let tileDraws = 0;
  let missingNames = 0;
  let animatedTiles = 0;
  const getTile = async name => {
    if (cache.has(name)) return cache.get(name);
    if (rejectedTiles.has(name)) return null;
    const path = `tile/${name}.til`;
    try {
      const source = await readRelated(path);
      if (!source) {
        cache.set(name, null);
        if (!issuePaths.has(path)) tileIssues.push({ path, reason: '缺少TIL图块资源' });
        issuePaths.add(path);
        return null;
      }
      const decoded = loadModernTile(source);
      if (cacheBytes + decoded.cacheBytes <= MAX_TILE_CACHE_BYTES) {
        cacheBytes += decoded.cacheBytes;
        cache.set(name, decoded);
        return decoded;
      }
      rejectedTiles.add(name);
      if (!issuePaths.has(path)) tileIssues.push({ path, reason: 'TIL缩小图块缓存超过32MiB上限' });
      issuePaths.add(path);
      return null;
    } catch (error) {
      cache.set(name, null);
      if (!issuePaths.has(path)) tileIssues.push({ path, reason: error.message });
      issuePaths.add(path);
      return null;
    }
  };
  const codes = [0, 0, 0, 0];
  const directions = [1, 2, 4, 8];
  for (let b = 0; b <= map.height - 2; b += 1) {
    for (let a = 0; a <= map.width - 2; a += 1) {
      codes[0] = modernCode(map, a, b + 1); // lb
      codes[1] = modernCode(map, a, b); // lt
      codes[2] = modernCode(map, a + 1, b); // rt
      codes[3] = modernCode(map, a + 1, b + 1); // rb
      if ((codes[0] & codes[1] & codes[2] & codes[3]) < 0) continue;
      tileDraws += 1;
      if (tileDraws > MAX_MODERN_DRAWS) throw new Error(`PMIT 有效地面图块超过${MAX_MODERN_DRAWS}绘制上限`);
      const names = [];
      for (const code of codes) names.push(codeNames.get(code) || null);
      const loaded = [];
      for (const tileName of names) loaded.push(tileName ? await getTile(tileName) : null);
      let animatedName = null;
      for (let index = 0; index < names.length; index += 1) {
        if (loaded[index]?.animation) { animatedName = names[index]; break; }
      }
      if (animatedName) animatedTiles += 1;
      const order = [0, 1, 2, 3].sort((left, right) => (codes[left] < 0 ? 999 : codes[left]) - (codes[right] < 0 ? 999 : codes[right]));
      const seen = new Set();
      const layers = [];
      for (const corner of order) {
        const code = codes[corner];
        if (code < 0 || seen.has(code)) continue;
        seen.add(code);
        const name = names[corner];
        const tile = loaded[corner];
        if (!name || !tile) {
          if (codeNames.has(code)) missingNames += 1;
          else if (!issuePaths.has(`code:${code}`)) {
            tileIssues.push({ reason: `tile.ini 没有地形code ${code} 的资源名映射` });
            issuePaths.add(`code:${code}`);
          }
          continue;
        }
        let mask = 0;
        for (let index = 0; index < 4; index += 1) if (codes[index] === code) mask |= directions[index];
        let shape;
        if (name === animatedName) shape = tile.animation?.firstFrame;
        else shape = tile.shapes[(mask === 15 || seen.size === 1 ? 14 : mask - 1)] || tile.shapes[14];
        if (shape) layers.push(shape);
      }
      const destX = Math.ceil(a * 128 / scale);
      const destY = Math.ceil(b * 128 / scale);
      const endX = Math.ceil((a + 1) * 128 / scale);
      const endY = Math.ceil((b + 1) * 128 / scale);
      for (let y = destY; y < endY; y += 1) {
        if (y < 0 || y >= height) continue;
        const sy = Math.min(127, Math.max(0, y * scale - b * 128));
        for (let x = destX; x < endX; x += 1) {
          if (x < 0 || x >= width) continue;
          const sx = Math.min(127, Math.max(0, x * scale - a * 128));
          const destOffset = (y * width + x) * 4;
          const sourceOffset = (sy * 128 + sx) * 4;
          for (const layer of layers) blendTilePixel(image.data, destOffset, layer, sourceOffset);
        }
      }
    }
  }
  const result = {
    kind: 'image', mime: 'image/png', width, height,
    base64: PNG.sync.write(image).toString('base64'),
    info: { format: 'gsm-ground-tile-overview', previewScale: scale,
      note: '现代 PMIT 地面按游戏四角VCode与TIL形状合成；动画仅显示首帧。',
      gridWidth: map.width, gridHeight: map.height, tileDraws, missingNames, animatedTiles, tileIssues },
  };
  return result;
}

// Port the cursor-moving branches of GsmMap.ParseObjects / ReadObj. Cover and
// fixed-object image payloads are length-checked and skipped, not rendered.
function parseLegacyObjects(bytes) {
  const version = bytes.readUInt32LE(0x38);
  const flags = bytes.readUInt32LE(0x40);
  let cursor = readI32(bytes, 0x3c, '对象区起点');
  const fixCount = checkedCount(readI32(bytes, 0x4c, '内嵌对象数量'), 100000, '内嵌对象');
  const libraryCount = checkedCount(readI32(bytes, 0x50, '库物件数量'), 100000, '库物件');
  const issues = [];
  if (version <= 0x10008) {
    issues.push({ reason: `GSM 版本 0x${version.toString(16)} 未覆盖已确认的普通物件表布局` });
    return { objects: [], issues };
  }

  function requireBytes(length, label) {
    if (!Number.isSafeInteger(length) || length < 0 || cursor < 0 || cursor > bytes.length - length) {
      throw new Error(`${label}超出 GSM 文件边界`);
    }
  }
  function skipBytes(length, label) {
    requireBytes(length, label);
    cursor += length;
  }
  function skipImagePayload(width, height, pitch, label) {
    // The client advances by pitch * height only when both dimensions are positive.
    if (width <= 0 || height <= 0) return;
    if (width > 2048 || height > 2048 || pitch < 0) throw new Error(`${label}图像尺寸或pitch无效`);
    const length = pitch * height;
    if (!Number.isSafeInteger(length)) throw new Error(`${label}图像载荷长度无效`);
    skipBytes(length, `${label}图像载荷`);
  }

  // 06000bce's optional prefix appears only through version 0x1ffff.
  if (version <= 0x1ffff && (flags & 1) !== 0) {
    requireBytes(16, 'GSM 对象区前缀');
    const count = checkedCount(readI32(bytes, cursor, '对象区前缀计数'), 1000000, '对象区前缀');
    const itemSize = checkedCount(readI32(bytes, cursor + 4, '对象区前缀步长'), bytes.length, '对象区前缀步长');
    const payloadSize = count * itemSize;
    if (!Number.isSafeInteger(payloadSize)) throw new Error('对象区前缀载荷长度无效');
    skipBytes(16 + payloadSize, 'GSM 对象区前缀');
    issues.push({ reason: 'GSM 含对象区前置数据；已按声明长度跳过，未绘制' });
  }

  // ParseCover's exact cursor shape: 24-byte dimensions, then row-major
  // 16-byte image headers and pitch*height bytes for positive dimensions.
  if ((flags & 2) !== 0) {
    requireBytes(24, 'GSM Cover 头');
    const columns = readI32(bytes, cursor + 16, 'Cover列数');
    const rows = readI32(bytes, cursor + 20, 'Cover行数');
    if (columns < 1 || columns > 256 || rows < 1 || rows > 256) throw new Error('GSM Cover 网格尺寸无效');
    cursor += 24;
    for (let index = 0; index < columns * rows; index += 1) {
      requireBytes(16, 'GSM Cover 图像头');
      const width = readI32(bytes, cursor, 'Cover图像宽');
      const height = readI32(bytes, cursor + 4, 'Cover图像高');
      const pitch = readI32(bytes, cursor + 8, 'Cover图像pitch');
      cursor += 16;
      skipImagePayload(width, height, pitch, 'Cover');
    }
    issues.push({ reason: 'GSM 含 Cover 覆盖图层；已安全跳过其图像载荷，当前未绘制' });
  }

  // ParseFixedObjects advances through each object header, optional clip table,
  // and per-frame image header/payload before the library object table begins.
  if (fixCount > 0) {
    for (let objectIndex = 0; objectIndex < fixCount; objectIndex += 1) {
      const headerSize = version > 0x10000 ? 48 : 28;
      requireBytes(headerSize, `GSM 固定物件 ${objectIndex + 1} 头`);
      const frames = readI32(bytes, cursor + 16, '固定物件帧数');
      const clipCount = readI32(bytes, cursor + 24, '固定物件clip数量');
      if (frames < 0 || frames > 4096 || clipCount < 0 || clipCount >= 100000) {
        throw new Error(`GSM 固定物件 ${objectIndex + 1} 帧数或clip数量无效`);
      }
      cursor += headerSize;
      if (clipCount > 0) skipBytes(clipCount * 4, `GSM 固定物件 ${objectIndex + 1} clip表`);
      for (let frameIndex = 0; frameIndex < frames; frameIndex += 1) {
        requireBytes(32, `GSM 固定物件 ${objectIndex + 1} 第 ${frameIndex + 1} 帧头`);
        const width = readI32(bytes, cursor + 8, '固定物件帧图像宽');
        const height = readI32(bytes, cursor + 12, '固定物件帧图像高');
        const pitch = readI32(bytes, cursor + 16, '固定物件帧图像pitch');
        cursor += 32;
        skipImagePayload(width, height, pitch, '固定物件帧');
      }
    }
    issues.push({ reason: `GSM 含 ${fixCount} 个内嵌固定物件；已安全跳过其帧数据，当前未绘制` });
  }

  // Flag bit 2 selects a literal four-byte skip; otherwise the skip is zero.
  skipBytes(flags & 4, 'GSM 对象区短字段');

  if (version <= 0x20000 && (flags & 0x10) !== 0) {
    requireBytes(4, 'GSM 对象区附加计数');
    const count = checkedCount(readI32(bytes, cursor, '对象区附加计数'), 100000, '对象区附加记录');
    const payloadSize = count * 396;
    if (!Number.isSafeInteger(payloadSize)) throw new Error('对象区附加记录长度无效');
    skipBytes(4 + payloadSize, 'GSM 对象区附加记录');
    issues.push({ reason: `GSM 含 ${count} 个附加对象记录；已按固定396字节长度跳过，当前未绘制` });
  }

  const tileCount = checkedCount(readI32(bytes, cursor, '地面装饰物件数量'), 100000, '地面装饰物件');
  requireBytes(version >= 0x20004 ? 8 : 4, 'GSM 地面装饰物件计数头');
  cursor += version >= 0x20004 ? 8 : 4;

  function readObject(kind, index) {
    const size = 36 + (version >= 0x10006 ? 20 : 0) + (version === 0x20006 ? 8 : 0);
    if (cursor > bytes.length - size) throw new Error(`GSM ${kind}物件 ${index} 数据被截断`);
    const id = readI32(bytes, cursor + 8, '物件资源ID');
    const pivotY = readI32(bytes, cursor + 16, '物件排序锚点');
    const pivotZ = readI32(bytes, cursor + 20, '物件垂直锚点');
    cursor += 36;
    const object = { kind, id, pivotY, pivotZ, x: 0, y: 0, extentWidth: 0, extentHeight: 0 };
    if (version >= 0x10006) {
      object.x = readI32(bytes, cursor, '物件世界X');
      object.y = readI32(bytes, cursor + 4, '物件世界Y');
      object.extentWidth = readI32(bytes, cursor + 8, '物件宽度');
      object.extentHeight = readI32(bytes, cursor + 12, '物件高度');
      cursor += 20;
      if (version === 0x20006) cursor += 8;
    }
    return object;
  }

  const objects = [];
  let totalObjects = 0;
  for (let i = 0; i < tileCount; i += 1) {
    const object = readObject('tile', i);
    totalObjects += 1;
    if (objects.length < MAX_OBJECTS) objects.push(object);
  }
  if (libraryCount > 0 && version > 0x10001 && (flags & 0x80) !== 0) {
    for (let i = 0; i < libraryCount; i += 1) {
      const object = readObject('library', i);
      totalObjects += 1;
      if (objects.length < MAX_OBJECTS) objects.push(object);
    }
  }
  if (totalObjects > MAX_OBJECTS) {
    issues.push({ reason: `普通物件共 ${totalObjects} 个，预览上限为 ${MAX_OBJECTS}；已限制物件图层` });
  }
  if (version > 0x20003 && (flags & 0x1000) !== 0) {
    issues.push({ reason: 'GSM 含 FieldColor 颜色层；当前场景未绘制该逻辑图层' });
  }
  return { objects, issues };
}

function objectPath(id) {
  const groupIndex = (id >>> 16) & 0xff;
  const group = OBJECT_GROUPS.get(groupIndex);
  if (!group) return null;
  const city = CITY_NAMES.get((id >>> 24) & 0xff);
  const suffix = `_${String(id & 0xffff).padStart(4, '0')}.gso`;
  const leaf = city ? `${group}_${city}${suffix}` : null;
  return { groupIndex, prefix: `object/${group}/`, suffix, path: leaf ? `object/${group}/${leaf}` : null };
}

function downsample(source, step) {
  const width = Math.ceil(source.width / step);
  const height = Math.ceil(source.height / step);
  const data = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    const sourceY = Math.min(source.height - 1, y * step);
    for (let x = 0; x < width; x += 1) {
      const sourceX = Math.min(source.width - 1, x * step);
      const from = (sourceY * source.width + sourceX) * 4;
      const to = (y * width + x) * 4;
      source.data.copy(data, to, from, from + 4);
    }
  }
  return { width, height, data };
}

function blendPixel(destination, destOffset, source, sourceOffset) {
  const alpha = source[sourceOffset + 3];
  if (alpha === 0) return;
  if (alpha === 255 || destination[destOffset + 3] === 0) {
    source.copy(destination, destOffset, sourceOffset, sourceOffset + 4);
    return;
  }
  const oldAlpha = destination[destOffset + 3];
  const inverse = 255 - alpha;
  const outputAlpha = alpha + Math.floor(oldAlpha * inverse / 255);
  for (let channel = 0; channel < 3; channel += 1) {
    destination[destOffset + channel] = Math.round((source[sourceOffset + channel] * alpha +
      destination[destOffset + channel] * oldAlpha * inverse / 255) / outputAlpha);
  }
  destination[destOffset + 3] = outputAlpha;
}

// Matches FloorRenderer.Over's byte arithmetic for compositing TIL layers.
function blendTilePixel(destination, destOffset, source, sourceOffset) {
  const alpha = source[sourceOffset + 3];
  if (alpha === 0) return;
  const inverse = 255 - alpha;
  destination[destOffset] = Math.floor((source[sourceOffset] * alpha + destination[destOffset] * inverse) / 255);
  destination[destOffset + 1] = Math.floor((source[sourceOffset + 1] * alpha + destination[destOffset + 1] * inverse) / 255);
  destination[destOffset + 2] = Math.floor((source[sourceOffset + 2] * alpha + destination[destOffset + 2] * inverse) / 255);
  destination[destOffset + 3] = alpha + Math.floor(destination[destOffset + 3] * inverse / 255);
}

function overlayImage(target, source, x, y) {
  const width = source.width;
  const height = source.height;
  const rect = { x, y, width, height };
  for (let dy = 0; dy < height; dy += 1) {
    const targetY = rect.y + dy;
    if (targetY < 0 || targetY >= target.height) continue;
    const sourceY = dy;
    for (let dx = 0; dx < width; dx += 1) {
      const targetX = rect.x + dx;
      if (targetX < 0 || targetX >= target.width) continue;
      const sourceX = dx;
      blendPixel(target.data, (targetY * target.width + targetX) * 4,
        source.data, (sourceY * source.width + sourceX) * 4);
    }
  }
  const x0 = Math.max(0, rect.x);
  const y0 = Math.max(0, rect.y);
  const x1 = Math.min(target.width, rect.x + rect.width);
  const y1 = Math.min(target.height, rect.y + rect.height);
  return x1 > x0 && y1 > y0 ? { x: x0, y: y0, width: x1 - x0, height: y1 - y0 } : null;
}

async function makeScenePreview(buffer, name, { readRelated, findRelatedPaths } = {}) {
  if (typeof name !== 'string' || !name.toLowerCase().endsWith('.gsm')) return null;
  if (!Buffer.isBuffer(buffer) || buffer.length < 0x6c) throw new Error('GSM 地图头部不完整');
  const issues = [];
  const relatedPaths = new Set();
  let relatedBytes = 0;
  const boundedRead = async path => {
    if (typeof readRelated !== 'function') return null;
    const repeated = relatedPaths.has(path);
    if (!repeated && relatedPaths.size >= 256) throw new Error('场景关联资源超过256项上限');
    relatedPaths.add(path);
    const data = await readRelated(path);
    if (data == null) return null;
    const bytes = Buffer.isBuffer(data) ? data : Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    if (bytes.length > MAX_RELATED_FILE_BYTES || (!repeated && relatedBytes + bytes.length > MAX_RELATED_BYTES)) {
      throw new Error('场景关联资源超过文件或总字节上限');
    }
    if (!repeated) relatedBytes += bytes.length;
    return bytes;
  };

  const modernMap = parseModernGsm(buffer);
  const ground = modernMap
    ? await renderModernGround(modernMap, boundedRead)
    : await makeMapPreview(buffer, name, { readRelated: boundedRead });
  if (!ground || ground.kind !== 'image' || ground.mime !== 'image/png') {
    throw new Error('无法生成 GSM 地面图像');
  }
  const groundPng = PNG.sync.read(Buffer.from(ground.base64, 'base64'));
  if (groundPng.width > 2048 || groundPng.height > 2048 || groundPng.width * groundPng.height > 4 * 1024 * 1024) {
    throw new Error('场景地面图超过2048边长或4M像素限制');
  }
  const matrixScale = Number(ground.info?.previewScale) || 1;
  let worldToImage = null;
  if (ground.info?.format === 'gsm-ground-tile-overview') {
    worldToImage = [1 / matrixScale, 0, 0, 1 / matrixScale, 0, 0];
  } else {
    issues.push({ reason: '地面使用网格概览图而非游戏像素画布，NPC/PRC/MSK 坐标无法准确映射' });
  }
  if (typeof ground.info?.note === 'string' && /首帧/.test(ground.info.note)) {
    issues.push({ reason: '地面动画图块仅显示首帧' });
  }
  if (Array.isArray(ground.info?.tileIssues)) issues.push(...ground.info.tileIssues);
  issues.push({ reason: '物件层仅用于资源定位与点击；未模拟客户端sortingOrder、动画及完整遮挡/合成顺序' });

  let objectPng = new PNG({ width: groundPng.width, height: groundPng.height, colorType: 6 });
  let objectRecords;
  try {
    objectRecords = parseLegacyObjects(buffer);
  } catch (error) {
    objectRecords = { objects: [], issues: [{ reason: `物件区无法解析：${error.message}；已保留地面预览` }] };
  }
  issues.push(...objectRecords.issues);
  const objects = [];
  let layerPixels = 0;
  let objectCacheBytes = 0;
  const objectAssets = new Map();
  const objectPathById = new Map();
  const uniqueAssetIds = new Set();
  const unresolvedIds = new Set();
  if (!worldToImage && objectRecords.objects.length > 0) {
    issues.push({ reason: '当前地面没有与游戏像素坐标对应的画布；未叠加物件图层以免错位' });
  }
  for (const item of worldToImage ? objectRecords.objects : []) {
    const id = item.id >>> 0;
    if (!uniqueAssetIds.has(id) && uniqueAssetIds.size >= MAX_OBJECT_ASSETS) {
      if (!unresolvedIds.has(id)) {
        unresolvedIds.add(id);
        issues.push({ reason: `不同GSO素材超过${MAX_OBJECT_ASSETS}项上限；后续物件已略过` });
      }
      continue;
    }
    uniqueAssetIds.add(id);
    if (!objectPathById.has(id)) {
      const expected = objectPath(item.id);
      if (!expected) objectPathById.set(id, null);
      else objectPathById.set(id, { ...expected, checked: false });
    }
    const resolved = objectPathById.get(id);
    if (!resolved) {
      if (unresolvedIds.has(id)) continue;
      unresolvedIds.add(id);
      issues.push({ reason: `物件ID 0x${(item.id >>> 0).toString(16)} 的资源分类没有已确认目录映射` });
      continue;
    }
    let asset = objectAssets.get(resolved.path);
    if (!asset) {
      if (!resolved.checked) {
        try {
          let source = resolved.path ? await boundedRead(resolved.path) : null;
          if (!source && typeof findRelatedPaths === 'function') {
            const matches = findRelatedPaths(resolved.prefix, resolved.suffix);
            if (matches.length > 1) {
              resolved.error = '客户端唯一后备匹配返回多个GSO路径，拒绝猜测';
            } else if (matches.length === 1) {
              resolved.path = matches[0];
              source = await boundedRead(resolved.path);
            } else {
              resolved.error = '客户端唯一后备匹配未找到候选GSO路径';
            }
          } else if (!source && !findRelatedPaths) {
            resolved.error = '物件城市码无固定映射，且没有包内唯一路径查询接口';
          }
          resolved.checked = true;
          if (source) {
            const rendered = renderStaticFrame(source);
            const origin = rendered.origin;
            if (!rendered || !['image', 'animation'].includes(rendered.kind) || rendered.mime !== 'image/png') {
              throw new Error('GSO 无法解码为 PNG 物件图像');
            }
            if (rendered.width * rendered.height > MAX_OBJECT_IMAGE_PIXELS) throw new Error('物件图像超过8M像素限制');
            const rawPng = PNG.sync.read(Buffer.from(rendered.base64, 'base64'));
            const pixels = downsample(rawPng, matrixScale * origin.tier);
            asset = { ...pixels, origin, tier: origin.tier, path: resolved.path };
            if (objectAssets.size < MAX_OBJECT_ASSETS && objectCacheBytes + pixels.data.length <= MAX_OBJECT_CACHE_BYTES) {
              objectAssets.set(resolved.path, asset);
              objectCacheBytes += pixels.data.length;
            } else resolved.error = '物件缩小图像超过16MiB缓存上限；仅可放置首次实例';
          }
        } catch (error) {
          resolved.error = error.message;
          resolved.checked = true;
        }
      } else {
        asset = resolved.path ? objectAssets.get(resolved.path) : null;
      }
    }
    asset ||= objectAssets.get(resolved.path);
    if (!asset && resolved.checked) {
      if (!unresolvedIds.has(id)) {
        unresolvedIds.add(id);
        issues.push({ path: resolved.path, reason: resolved.error || '精确路径及客户端唯一后备匹配均未找到可解码物件' });
      }
      continue;
    }
    if (!asset) {
      issues.push({ path: resolved.path, reason: '物件素材达到128项或16MiB缩图缓存上限' });
      continue;
    }
    if (layerPixels + asset.width * asset.height > MAX_OBJECT_LAYER_PIXELS) {
      issues.push({ path: resolved.path, reason: '物件层累计绘制像素超过32M上限' });
      continue;
    }
    layerPixels += asset.width * asset.height;
    const topLeftX = Math.floor((item.x + asset.origin.left) / matrixScale);
    const topLeftY = Math.floor((item.y + asset.origin.top - item.pivotZ) / matrixScale);
    const rect = overlayImage(objectPng, asset, topLeftX, topLeftY);
    if (!rect) {
      issues.push({ path: resolved.path, reason: '物件图像矩形完全位于地面画布外' });
      continue;
    }
    objects.push({
      id,
      label: `${item.kind === 'tile' ? '地面装饰' : '库物件'} ${item.id >>> 0}`,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      path: asset.path,
      details: `GSM锚点 ${item.x},${item.y}；pivotZ=${item.pivotZ}；资源首帧偏移 ${asset.origin.left},${asset.origin.top}；DIMG tier=${asset.tier}${asset.origin.clips ? `；含${asset.origin.clips}个clip条目（未模拟切片排序）` : ''}`,
    });
  }
  const hasObjects = objects.length > 0;
  const finalIssues = issues.slice(0, 512);
  if (issues.length > finalIssues.length) finalIssues.push({ reason: `另有 ${issues.length - finalIssues.length} 条问题未显示` });
  return {
    kind: 'map-scene',
    width: groundPng.width,
    height: groundPng.height,
    base64: ground.base64,
    mime: 'image/png',
    ...(hasObjects ? { objectLayer: { base64: PNG.sync.write(objectPng).toString('base64'), mime: 'image/png' } } : {}),
    worldToImage,
    objects,
    issues: finalIssues,
    info: `GSM 地面与普通静态库物件场景预览；地面 ${groundPng.width}×${groundPng.height}；对象 ${objects.length} 个。未解析的遮罩、Cover、内嵌固定物件或动画物件会在 issues 中说明。`,
  };
}

module.exports = { makeScenePreview };
