'use strict';

const { PNG } = require('pngjs');

const MAX_IMAGE_SIDE = 2048;
const MAX_IMAGE_PIXELS = 4 * 1024 * 1024;
const MAX_MAP_CELLS = 4 * 1024 * 1024;
const MAX_MAP_TILE_DRAWS = 250000;
const MAX_SOURCE_PIXELS = 32 * 1024 * 1024;
const TILE_WIDTH = 128;
const TILE_HEIGHT = 64;
const TILE_SURFACE_PIXELS = TILE_WIDTH * TILE_HEIGHT;
const TILE_PIXELS = 4096;
const TILE_RECORD_BYTES = TILE_PIXELS * 4;
const TILE_HEADER_SIZE = 64;
const TERRAIN_HEADER_SIZE = 48;
const TERRAIN_RECORD_SIZE = 1044;
const TERRAIN_COUNT = 544;
const MAX_TERRAIN_VARIANTS = 64;

// Shared validation helper: surface malformed or unsupported resource layouts to the caller.
function fail(message) {
  throw new Error(message);
}

// Shared worker boundary: accept Node buffers and Uint8Array views without copying.
function asBuffer(value) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  fail('资源数据不是二进制缓冲区。');
}

// Shared little-endian reader with explicit offset checks.
function i32(bytes, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > bytes.length) {
    fail('资源数据在读取整数时越界。');
  }
  return bytes.readInt32LE(offset);
}

// Shared little-endian reader with explicit offset checks.
function u32(bytes, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset + 4 > bytes.length) {
    fail('资源数据在读取整数时越界。');
  }
  return bytes.readUInt32LE(offset);
}

// Shared bounded PNG allocator and result serializer.
function makePng(width, height, info, pagination) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) ||
      width < 1 || height < 1 || width > MAX_IMAGE_SIDE || height > MAX_IMAGE_SIDE ||
      width * height > MAX_IMAGE_PIXELS) {
    fail('预览图片尺寸超出安全上限。');
  }
  const png = new PNG({ width, height, colorType: 6 });
  return {
    png,
    result() {
      const out = {
        kind: 'image',
        mime: 'image/png',
        base64: PNG.sync.write(png).toString('base64'),
        width,
        height,
        info,
      };
      if (pagination) {
        out.page = pagination.page;
        out.pageCount = pagination.pageCount;
      }
      return out;
    },
  };
}

// Shared clipped pixel writer used by grid and mask previews.
function putPixel(data, width, height, x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= width || y >= height) return;
  const offset = (y * width + x) * 4;
  data[offset] = r;
  data[offset + 1] = g;
  data[offset + 2] = b;
  data[offset + 3] = a;
}

// Shared scale selector keeps image dimensions and total pixel memory bounded.
function dimensionScale(width, height) {
  return Math.max(1, Math.ceil(width / MAX_IMAGE_SIDE), Math.ceil(height / MAX_IMAGE_SIDE),
    Math.ceil(Math.sqrt((width * height) / MAX_IMAGE_PIXELS)));
}

// Deterministic colors for the explicitly labeled terrain-code grid fallback.
function palette(value) {
  if (value < 0) return [12, 15, 22];
  let n = (value >>> 0) + 0x9e3779b9;
  n = Math.imul(n ^ (n >>> 16), 0x21f0aaad);
  n = Math.imul(n ^ (n >>> 15), 0x735a2d97);
  n ^= n >>> 15;
  return [72 + (n & 0x7f), 72 + ((n >>> 8) & 0x7f), 72 + ((n >>> 16) & 0x7f)];
}

// Source: ReferenceTerrainLibraries.cs:59-102 (TileImgLib header and payload guards).
function parseTileLibrary(input) {
  const bytes = asBuffer(input);
  if (bytes.length < TILE_HEADER_SIZE) fail('tileimg.dat 头部被截断。');
  if (bytes[0] !== 0x51 || bytes[1] !== 0x51 || bytes.toString('ascii', 4, 8) !== 'TILE') {
    fail('tileimg.dat 签名无效。');
  }
  const version = i32(bytes, 8);
  const headerSize = i32(bytes, 12);
  const width = i32(bytes, 16);
  const height = i32(bytes, 20);
  const format = i32(bytes, 24);
  const count = i32(bytes, 28);
  if (version !== 65536 || headerSize !== TILE_HEADER_SIZE || width !== TILE_WIDTH ||
      height !== TILE_HEIGHT || format !== 1 || count < 1 || count > 0x7fffffff) {
    fail('tileimg.dat 版本或图块参数不受支持。');
  }
  const expectedLength = TILE_HEADER_SIZE + count * TILE_RECORD_BYTES;
  if (!Number.isSafeInteger(expectedLength) || expectedLength !== bytes.length) {
    fail('tileimg.dat 载荷长度与图块数量不匹配。');
  }
  return { bytes, count };
}

// Source: ReferenceTerrainLibraries.cs:105-132 (BGRA records projected into diamond coordinates).
function decodeTile(library, imageId) {
  if (!Number.isInteger(imageId) || imageId < 0 || imageId >= library.count) return null;
  const pixels = Buffer.alloc(TILE_SURFACE_PIXELS * 4);
  const sourceStart = TILE_HEADER_SIZE + imageId * TILE_RECORD_BYTES;
  let cursor = 0;
  for (let row = 0; row < TILE_HEIGHT; row++) {
    const first = row < TILE_HEIGHT / 2
      ? TILE_WIDTH / 2 - row * 2
      : (row - (TILE_HEIGHT / 2 - 1)) * 2;
    const span = row < TILE_HEIGHT / 2
      ? row * 4 + 2
      : (TILE_HEIGHT - row) * 4 - 2;
    for (let x = first; x < first + span; x++) {
      const source = sourceStart + cursor * 4;
      const dest = (row * TILE_WIDTH + x) * 4;
      pixels[dest] = library.bytes[source + 2];
      pixels[dest + 1] = library.bytes[source + 1];
      pixels[dest + 2] = library.bytes[source];
      pixels[dest + 3] = library.bytes[source + 3];
      cursor++;
    }
  }
  if (cursor !== TILE_PIXELS) fail('tileimg.dat 图块像素数量无效。');
  return pixels;
}

// Source: ReferenceTerrainLibraries.cs:220-267 (terrashp header, records and variant count).
function parseTerrainLibrary(input) {
  const bytes = asBuffer(input);
  if (bytes.length < TERRAIN_HEADER_SIZE) fail('terrashp.dat 头部被截断。');
  if (bytes.toString('ascii', 0, 8) !== 'RAYSTRSP') fail('terrashp.dat 签名无效。');
  if (i32(bytes, 8) !== 65537 || i32(bytes, 12) !== TERRAIN_HEADER_SIZE ||
      i32(bytes, 16) !== TERRAIN_COUNT) {
    fail('terrashp.dat 版本或记录数量不受支持。');
  }
  const expectedLength = TERRAIN_HEADER_SIZE + TERRAIN_COUNT * TERRAIN_RECORD_SIZE;
  if (bytes.length !== expectedLength) fail('terrashp.dat 载荷长度不匹配。');
  let totalVariants = 0;
  let populatedTerrains = 0;
  let imageIds = 0;
  let minVariants = MAX_TERRAIN_VARIANTS;
  let maxVariants = 0;
  const counts = new Uint8Array(TERRAIN_COUNT);
  for (let terrain = 0; terrain < TERRAIN_COUNT; terrain++) {
    const record = TERRAIN_HEADER_SIZE + terrain * TERRAIN_RECORD_SIZE;
    const count = i32(bytes, record + 12);
    if (count < 0 || count > MAX_TERRAIN_VARIANTS) {
      fail(`terrashp.dat 地形 ${terrain} 的变体数量越界。`);
    }
    counts[terrain] = count;
    totalVariants += count;
    if (count > 0) populatedTerrains++;
    minVariants = Math.min(minVariants, count);
    maxVariants = Math.max(maxVariants, count);
    for (let entry = 0; entry < count * 4; entry++) {
      const imageId = i32(bytes, record + 20 + entry * 4);
      if (imageId >= 0) imageIds++;
    }
  }
  return { bytes, counts, totalVariants, populatedTerrains, imageIds, minVariants, maxVariants };
}

// Source: ReferenceTerrainLibraries.cs:270-331 (terrain, variant and frame lookup).
function terrainImageId(library, code, frame = 0) {
  if (code < 0) return -1;
  let terrain;
  if ((code & 267386880) === 0) {
    terrain = (code >> 8) & 0xff;
  } else {
    const encodedTerrain = (code >> 16) & 0xfff;
    if ((encodedTerrain & 0xff0) > 0x20f) return -1;
    terrain = encodedTerrain + 16;
  }
  if (terrain < 0 || terrain >= TERRAIN_COUNT) return -1;
  const count = library.counts[terrain];
  if (count < 1) return -1;
  let variant = code & 0xff;
  if (variant >= count) variant = 0;
  const selectedFrame = frame >= 0 && frame < 4 ? frame : 0;
  const record = TERRAIN_HEADER_SIZE + terrain * TERRAIN_RECORD_SIZE;
  return i32(library.bytes, record + 20 + (variant * 4 + selectedFrame) * 4);
}

// Source: ReferenceTerrainLibraries.cs:48-53,105-132; the page layout is a bounded preview presentation.
function tileSheet(input, page) {
  const library = parseTileLibrary(input);
  const pageSize = 64;
  const pageCount = Math.ceil(library.count / pageSize);
  if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
    fail(`tileimg.dat 页码越界；有效页为 0 到 ${pageCount - 1}。`);
  }
  const columns = 8;
  const cellWidth = TILE_WIDTH + 4;
  const cellHeight = TILE_HEIGHT + 4;
  const width = columns * cellWidth;
  const height = Math.ceil(pageSize / columns) * cellHeight;
  const out = makePng(width, height, {
    format: 'tileimg', tileCount: library.count, pageSize, columns,
    note: '按包内图块顺序排列；透明区域保留。',
  }, { page, pageCount });
  for (let local = 0; local < pageSize; local++) {
    const imageId = page * pageSize + local;
    if (imageId >= library.count) break;
    const tile = decodeTile(library, imageId);
    const col = local % columns;
    const row = Math.floor(local / columns);
    const x0 = col * cellWidth + 2;
    const y0 = row * cellHeight + 2;
    for (let y = 0; y < TILE_HEIGHT; y++) {
      const dest = ((y0 + y) * width + x0) * 4;
      tile.copy(out.png.data, dest, y * TILE_WIDTH * 4, (y + 1) * TILE_WIDTH * 4);
    }
  }
  return out.result();
}

// Source: ReferenceTerrainLibraries.cs:194-213,256-291; render exact table entries as paged text.
function terrainSheet(input, page) {
  const library = parseTerrainLibrary(input);
  const pageSize = 64;
  const pageCount = Math.ceil(TERRAIN_COUNT / pageSize);
  if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
    fail(`terrashp.dat 页码越界；有效页为 0 到 ${pageCount - 1}。`);
  }
  const first = page * pageSize;
  const end = Math.min(TERRAIN_COUNT, first + pageSize);
  const rows = [];
  for (let terrain = first; terrain < end; terrain++) {
    const count = library.counts[terrain];
    const record = TERRAIN_HEADER_SIZE + terrain * TERRAIN_RECORD_SIZE;
    const variants = [];
    for (let variant = 0; variant < count; variant++) {
      const frames = [];
      for (let frame = 0; frame < 4; frame++) {
        const imageId = i32(library.bytes, record + 20 + (variant * 4 + frame) * 4);
        frames.push(imageId);
      }
      variants.push(`${variant}[${frames.join(',')}]`);
    }
    rows.push(`${String(terrain).padStart(3, '0')} (${count}): ${variants.join(' ') || '无图块变体'}`);
  }
  return {
    kind: 'text',
    text: `terrashp.dat 地形图块映射（第 ${page + 1}/${pageCount} 页；每条变体列出 4 帧 imageId）\n${rows.join('\n')}`,
    info: {
      format: 'terrashp', terrainCount: TERRAIN_COUNT, recordStride: TERRAIN_RECORD_SIZE,
      totalVariants: library.totalVariants, populatedTerrains: library.populatedTerrains,
      imageIdEntries: library.imageIds, minVariants: library.minVariants,
      maxVariants: library.maxVariants, pageSize, firstTerrain: first, lastTerrain: end - 1,
    },
    page,
    pageCount,
  };
}

// Source: GsmMap.cs:46-124 (PMIT branch), with the old grid path kept separate below.
function parseGsm(input) {
  const bytes = asBuffer(input);
  if (bytes.length < 0x6c) fail('GSM 地图头部被截断。');
  const version = u32(bytes, 0x38);
  const flags = u32(bytes, 0x40);
  const reportedWidth = i32(bytes, 0x60);
  const reportedHeight = i32(bytes, 0x64);
  const tileSet = i32(bytes, 0x68);
  const marker = bytes.indexOf(Buffer.from('PMIT', 'ascii'));
  if (marker < 0) return parseLegacyGsm(bytes, { version, flags, reportedWidth, reportedHeight, tileSet });
  if (marker + 8 > bytes.length || reportedWidth < 1 || reportedHeight < 1 ||
      reportedWidth >= 0x7fffffff || reportedHeight >= 0x7fffffff) {
    fail('GSM 地图网格尺寸无效。');
  }
  let width = reportedWidth + 1;
  let height = reportedHeight + 1;
  const byteCount = i32(bytes, marker + 4);
  if (byteCount <= 0 || (byteCount & 3) !== 0) fail('GSM PMIT 网格长度无效。');
  const declaredCount = byteCount / 4;
  if (declaredCount !== width * height) {
    if (height !== 0 && declaredCount % height === 0) width = declaredCount / height;
    else if (width !== 0 && declaredCount % width === 0) height = declaredCount / width;
  }
  const cellCount = width * height;
  if (!Number.isSafeInteger(cellCount) || width < 1 || height < 1 || cellCount > MAX_MAP_CELLS ||
      cellCount !== declaredCount) {
    fail('GSM 网格超过预览上限或维度与载荷不匹配。');
  }
  const gridStart = marker + 8;
  const gridEnd = gridStart + cellCount * 4;
  if (!Number.isSafeInteger(gridEnd) || gridEnd > bytes.length) fail('GSM 网格数据被截断。');
  const grids = new Int32Array(cellCount);
  for (let index = 0; index < cellCount; index++) {
    const value = bytes.readUInt32LE(gridStart + index * 4);
    grids[index] = value >= 1 && value <= 255 ? value << 8 : -1;
  }
  return {
    width, height, grids, tileSet: tileSet >= 0 && tileSet <= 13 ? tileSet : 0,
    version, flags, sourceBytes: bytes.length,
  };
}

// Source: GsmMap.cs:61-97,221-234 (legacy dimension and field-probe rules).
function parseLegacyGsm(bytes, header) {
  const { version, flags, reportedWidth, reportedHeight, tileSet } = header;
  if (reportedWidth < 1 || reportedHeight < 1 || reportedWidth > 4095 || reportedHeight > 4095) {
    fail('旧式 GSM 地图的网格尺寸无效。');
  }
  const cellCount = reportedWidth * reportedHeight;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_MAP_CELLS) {
    fail('旧式 GSM 地图网格超过预览上限。');
  }
  const fieldSize = 16 + cellCount * 12;
  const objectStart = i32(bytes, 0x3c);
  if (objectStart < 0 || objectStart > bytes.length || fieldSize > bytes.length - objectStart) {
    fail('旧式 GSM 地图的地面网格区域被截断。');
  }
  const lastCandidate = bytes.length - fieldSize;
  if (lastCandidate - objectStart > 8 * 1024 * 1024) {
    fail('旧式 GSM 地图网格搜索超过安全扫描上限。');
  }
  const probeCount = Math.min(16, cellCount);
  let found = -1;
  for (let candidate = objectStart; candidate <= lastCandidate; candidate++) {
    if (i32(bytes, candidate) !== reportedWidth || i32(bytes, candidate + 4) !== reportedHeight) continue;
    let accepted = true;
    for (let probe = 0, offset = candidate + 24; probe < probeCount; probe++, offset += 12) {
      if (u32(bytes, offset) !== 0) { accepted = false; break; }
    }
    if (accepted) { found = candidate; break; }
  }
  if (found < 0) fail('旧式 GSM 地图中找不到有效地面网格。');
  const grids = new Int32Array(cellCount);
  for (let index = 0, offset = found + 16; index < cellCount; index++, offset += 12) {
    const kind = bytes[offset] & 0xf0;
    grids[index] = kind === 0x10 || kind === 0x20 ? -1 : i32(bytes, offset + 4);
  }
  return {
    width: reportedWidth,
    height: reportedHeight,
    grids,
    tileSet: tileSet >= 0 && tileSet <= 13 ? tileSet : 0,
    version,
    flags,
    sourceBytes: bytes.length,
    legacy: true,
  };
}

// Source: independent worker contract; read only the path passed to the callback.
async function related(readRelated, path) {
  if (typeof readRelated !== 'function') return null;
  const value = await readRelated(path);
  return value == null ? null : asBuffer(value);
}

// Source: GsmMap.cs:182-200; palette is explicitly a grid-only fallback.
function gridOverview(map, reason) {
  const scale = dimensionScale(map.width, map.height);
  const width = Math.ceil(map.width / scale);
  const height = Math.ceil(map.height / scale);
  const out = makePng(width, height, {
    format: 'gsm-grid-overview', gridWidth: map.width, gridHeight: map.height,
    version: map.version, tileSet: map.tileSet,
    previewScale: scale,
    note: `这是地形编码网格概览，不是图块画面。${reason}`,
  });
  for (let y = 0; y < map.height; y += scale) {
    for (let x = 0; x < map.width; x += scale) {
      const value = map.grids[y * map.width + x];
      const [r, g, b] = palette(value < 0 ? -1 : value >>> 8);
      putPixel(out.png.data, width, height, Math.floor(x / scale), Math.floor(y / scale), r, g, b, value < 0 ? 90 : 255);
    }
  }
  return out.result();
}

// Source: FloorRenderer.Legacy.cs:38,65; map tiles are scaled to the output pixel budget.
function drawTileScaled(target, tile, targetX, targetY, scale) {
  const imageScale = Math.max(1, scale);
  const scaledW = Math.max(1, Math.ceil(TILE_WIDTH / imageScale));
  const scaledH = Math.max(1, Math.ceil(TILE_HEIGHT / imageScale));
  const x0 = Math.floor(targetX / imageScale);
  const y0 = Math.floor(targetY / imageScale);
  for (let y = 0; y < scaledH; y++) {
    const sourceY = Math.min(TILE_HEIGHT - 1, y * imageScale);
    for (let x = 0; x < scaledW; x++) {
      const sourceX = Math.min(TILE_WIDTH - 1, x * imageScale);
      const source = (sourceY * TILE_WIDTH + sourceX) * 4;
      const alpha = tile[source + 3];
      if (alpha === 0) continue;
      const dx = x0 + x;
      const dy = y0 + y;
      if (dx < 0 || dy < 0 || dx >= target.width || dy >= target.height) continue;
      const dest = (dy * target.width + dx) * 4;
      if (alpha === 255) {
        target.data[dest] = tile[source];
        target.data[dest + 1] = tile[source + 1];
        target.data[dest + 2] = tile[source + 2];
        target.data[dest + 3] = 255;
      } else {
        const alphaFactor = alpha / 255;
        const inverse = 1 - alphaFactor;
        const destAlpha = target.data[dest + 3] / 255;
        const outputAlpha = alphaFactor + destAlpha * inverse;
        if (outputAlpha > 0) {
          target.data[dest] = Math.round((tile[source] * alphaFactor + target.data[dest] * destAlpha * inverse) / outputAlpha);
          target.data[dest + 1] = Math.round((tile[source + 1] * alphaFactor + target.data[dest + 1] * destAlpha * inverse) / outputAlpha);
          target.data[dest + 2] = Math.round((tile[source + 2] * alphaFactor + target.data[dest + 2] * destAlpha * inverse) / outputAlpha);
          target.data[dest + 3] = Math.round(outputAlpha * 255);
        }
      }
    }
  }
}

// Source: FloorRenderer.Legacy.cs:65 and ReferenceTerrainLibraries.cs:105-132,294-331.
function mapTiles(map, tileInput, terrainInput) {
  const tileLibrary = parseTileLibrary(tileInput);
  const terrainLibrary = parseTerrainLibrary(terrainInput);
  const rawWidth = (map.width + map.height) * 64;
  const rawHeight = (map.width + map.height) * 32;
  const scale = dimensionScale(rawWidth, rawHeight);
  const width = Math.ceil(rawWidth / scale);
  const height = Math.ceil(rawHeight / scale);
  const out = makePng(width, height, {
    format: 'gsm-ground-tile-overview', gridWidth: map.width, gridHeight: map.height,
    version: map.version, tileSet: map.tileSet, previewScale: scale,
    tileImageCount: tileLibrary.count, terrainCount: TERRAIN_COUNT,
    note: map.legacy
      ? '仅绘制旧式 GSM 地面网格解析出的首帧图块，不含固定或动态物件、遮罩和场景效果。'
      : '仅绘制 GSM 地面网格解析出的首帧图块，不含固定或动态物件、遮罩和场景效果。现代 PMIT 网格按地形编码选图，仅作图块示意，不承诺复现游戏内完整混合地形。',
  });
  const cache = new Map();
  const cacheLimit = 96;
  const totalCells = map.width * map.height;
  if (totalCells > MAX_MAP_TILE_DRAWS) {
    fail('地图网格过大，拒绝跳格绘制以免产生误导；请使用编码网格概览。');
  }
  const sampleStep = 1;
  let rendered = 0;
  let missingTileRefs = 0;
  for (let y = 0; y < map.height; y += sampleStep) {
    for (let x = 0; x < map.width; x += sampleStep) {
      const code = map.grids[y * map.width + x];
      const imageId = terrainImageId(terrainLibrary, code, 0);
      if (imageId < 0 || imageId >= tileLibrary.count) {
        if (code >= 0) missingTileRefs++;
        continue;
      }
      let tile = cache.get(imageId);
      if (!tile) {
        tile = decodeTile(tileLibrary, imageId);
        if (cache.size >= cacheLimit) cache.delete(cache.keys().next().value);
        cache.set(imageId, tile);
      }
      const xRaw = (map.height - y + x) * 64 - 64;
      const yRaw = (y + x) * 32;
      drawTileScaled(out.png, tile, xRaw, yRaw, scale);
      rendered++;
    }
  }
  const result = out.result();
  result.info.sampleStep = sampleStep;
  result.info.renderedCells = rendered;
  result.info.cellsWithoutMappedImage = missingTileRefs;
  return result;
}

// Source: ResLoader.ReadMap path binding plus ReferenceTerrainLibraries resource-name methods.
async function gsmPreview(bytes, name, options) {
  const map = parseGsm(bytes);
  if (map.width * map.height > MAX_MAP_TILE_DRAWS) {
    return gridOverview(map, '完整地面图块绘制超过安全上限，已显示编码网格概览。');
  }
  const tilePath = map.tileSet === 0 ? 'tile/tileimg.dat' : `tile/tileimg${String(map.tileSet).padStart(2, '0')}.dat`;
  const terrainPath = map.tileSet === 0 ? 'tile/terrashp.dat' : `tile/terrashp${String(map.tileSet).padStart(2, '0')}.dat`;
  const tileBytes = await related(options.readRelated, tilePath);
  const terrainBytes = await related(options.readRelated, terrainPath);
  if (!tileBytes || !terrainBytes) {
    const missing = [!tileBytes ? tilePath : null, !terrainBytes ? terrainPath : null].filter(Boolean);
    return gridOverview(map, `缺少关联资源：${missing.join('、')}。`);
  }
  return mapTiles(map, tileBytes, terrainBytes);
}

// Source: ReferenceWorldCollisionMask.cs:24-141 (bounded QQF MASK structure).
function parseTerrainMask(input) {
  const bytes = asBuffer(input);
  const headerSize = 32;
  const magic = Buffer.from([0x51, 0x51, 0x46, 0x1a, 0x4d, 0x41, 0x53, 0x4b]);
  if (bytes.length < headerSize) fail('MSK 碰撞图头部被截断。');
  if (!bytes.subarray(0, 8).equals(magic)) fail('MSK 碰撞图签名无效。');
  const width = i32(bytes, 16);
  const height = i32(bytes, 20);
  const cellCount = width * height;
  if (!Number.isSafeInteger(cellCount) || width < 1 || height < 1 || cellCount > MAX_MAP_CELLS) {
    fail('MSK 碰撞网格尺寸超出安全上限。');
  }
  const dataOffset = bytes.length - cellCount;
  if (dataOffset < headerSize) fail('MSK 碰撞网格载荷被截断。');
  return {
    bytes, width, height, dataOffset,
    cellWidth: i32(bytes, 24) < 1 ? 10 : i32(bytes, 24),
    cellHeight: i32(bytes, 28) < 1 ? 10 : i32(bytes, 28),
  };
}

// Source: ReferenceWorldCollisionMask.cs:144-154 (0x80 blocked-cell flag).
function mskPreview(input) {
  const mask = parseTerrainMask(input);
  const scale = dimensionScale(mask.width, mask.height);
  const width = Math.ceil(mask.width / scale);
  const height = Math.ceil(mask.height / scale);
  const out = makePng(width, height, {
    format: 'qqf-mask', gridWidth: mask.width, gridHeight: mask.height,
    cellWidthPixels: mask.cellWidth, cellHeightPixels: mask.cellHeight,
    blockedBit: '0x80', previewScale: scale,
    legend: '红色为阻挡格（0x80 位），绿色为可通行格。',
  });
  let blocked = 0;
  for (let y = 0; y < mask.height; y++) {
    for (let x = 0; x < mask.width; x++) {
      const value = mask.bytes[mask.dataOffset + x + mask.width * y];
      if ((value & 0x80) !== 0) blocked++;
      if (x % scale !== 0 || y % scale !== 0) continue;
      const color = (value & 0x80) !== 0 ? [220, 76, 66] : [76, 174, 118];
      putPixel(out.png.data, width, height, Math.floor(x / scale), Math.floor(y / scale), color[0], color[1], color[2]);
    }
  }
  const result = out.result();
  result.info.blockedCells = blocked;
  result.info.walkableCells = mask.width * mask.height - blocked;
  return result;
}

// Source: ReferenceFirstWorldMinimapHud.cs:88-244 (tiled BGRA4444 minimap raster).
function smpPreview(input) {
  const bytes = asBuffer(input);
  const minimumLength = 0x78;
  const firstTileOffset = 0x60;
  if (bytes.length <= minimumLength) fail('SMP 采样图数据被截断。');
  if (bytes[0] !== 0x54) fail('SMP 采样图签名无效。');
  let width = i32(bytes, 0x40);
  let height = i32(bytes, 0x44);
  let tileWidth = i32(bytes, 0x50);
  let tileHeight = i32(bytes, 0x54);
  let planes = i32(bytes, 0x58);
  let levels = i32(bytes, 0x5c);
  if (planes < 1 || planes > 16 || levels < 1 || levels > 16) {
    planes = 1;
    levels = 1;
  }
  if (width < 1 || height < 1 || tileWidth < 1 || tileHeight < 1 ||
      width > planes * tileWidth || height > levels * tileHeight ||
      width * height > MAX_MAP_CELLS) {
    fail('SMP 采样图尺寸或分块布局无效。');
  }
  const scale = dimensionScale(width, height);
  const outWidth = Math.ceil(width / scale);
  const outHeight = Math.ceil(height / scale);
  const out = makePng(outWidth, outHeight, {
    format: 'smp-sketch-raster', width, height, tileWidth, tileHeight, planes, levels,
    cellWidth: bytes.readFloatLE(0x38), cellHeight: bytes.readFloatLE(0x3c),
    previewScale: scale,
    note: '解码 SMP 分块链中的 BGRA4444 采样栅格。',
  });
  let tileOffset = firstTileOffset;
  let walkedPixels = 0;
  for (let tileIndex = 0; tileIndex < planes * levels; tileIndex++) {
    if (tileOffset + 16 > bytes.length) fail(`SMP 第 ${tileIndex} 个分块头部被截断。`);
    const pixelWidth = i32(bytes, tileOffset);
    const pixelHeight = i32(bytes, tileOffset + 4);
    const pitch = i32(bytes, tileOffset + 8);
    const format = i32(bytes, tileOffset + 12);
    const dataOffset = tileOffset + 16;
    if (format !== 1 || pixelWidth < 1 || pixelHeight < 1 || pitch < pixelWidth * 2) {
      fail(`SMP 第 ${tileIndex} 个分块参数不受支持。`);
    }
    const end = dataOffset + pitch * pixelHeight;
    const tilePixels = pixelWidth * pixelHeight;
    if (!Number.isSafeInteger(tilePixels)) fail(`SMP 第 ${tileIndex} 个分块尺寸超出安全上限。`);
    walkedPixels += tilePixels;
    if (!Number.isSafeInteger(end) || end > bytes.length || walkedPixels > MAX_SOURCE_PIXELS) {
      fail(`SMP 第 ${tileIndex} 个分块数据越界或超过解码上限。`);
    }
    const tileCol = tileIndex % planes;
    const tileRow = Math.floor(tileIndex / planes);
    const originX = tileCol * tileWidth;
    const originY = tileRow * tileHeight;
    for (let y = 0; y < pixelHeight; y++) {
      const sourceRow = dataOffset + y * pitch;
      const destY = originY + y;
      if (destY >= height || destY % scale !== 0) continue;
      for (let x = 0; x < pixelWidth; x++) {
        const destX = originX + x;
        if (destX >= width || destX % scale !== 0) continue;
        const low = bytes[sourceRow + x * 2];
        const high = bytes[sourceRow + x * 2 + 1];
        const expand = nibble => nibble * 17;
        putPixel(out.png.data, outWidth, outHeight, Math.floor(destX / scale), Math.floor(destY / scale),
          expand(high & 0x0f), expand(low >> 4), expand(low & 0x0f), expand(high >> 4));
      }
    }
    tileOffset = end;
  }
  return out.result();
}

// Match package logical paths independently of platform path separators.
function isNamed(name, suffix) {
  return typeof name === 'string' && name.toLowerCase().endsWith(suffix);
}

// Public preview entry point; only the named resource and optional package-local related reader are used.
async function makeMapPreview(buffer, name, { readRelated, page = 0 } = {}) {
  if (typeof name !== 'string') return null;
  if (isNamed(name, '.gsm')) return gsmPreview(buffer, name, { readRelated });
  if (isNamed(name, '.msk')) return mskPreview(buffer);
  if (isNamed(name, '.smp')) return smpPreview(buffer);
  if (/\/tile\/tileimg(?:\d{2})?\.dat$/i.test(`/${name.replace(/\\/g, '/')}`)) {
    return tileSheet(buffer, page);
  }
  if (/\/tile\/terrashp(?:\d{2})?\.dat$/i.test(`/${name.replace(/\\/g, '/')}`)) {
    return terrainSheet(buffer, page);
  }
  return null;
}

module.exports = { makeMapPreview };
