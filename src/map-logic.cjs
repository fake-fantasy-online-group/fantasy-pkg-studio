'use strict';

const { PNG } = require('pngjs');
const { plannedFields } = require('./ovplan-preview.cjs');
const ovManifest = require('./formats/ovmanifest.json');

const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_PRC_BYTES = 32 * 1024 * 1024;
const MAX_MARKERS = 10000;
const MAX_ISSUES = 1000;
const MAX_POLYGON_POINTS = 16;
const MAX_COORDINATE = 10000000;
const MAX_MASK_SIDE = 2048;
const MAX_MASK_PIXELS = 4 * 1024 * 1024;
const MAX_MASK_SOURCE_CELLS = 32 * 1024 * 1024;
const PRC_MAGIC = Buffer.from([0x51, 0x51, 0x46, 0x1a, 0x50, 0x52, 0x4f, 0x43]);
const PRC_VERSION = 65537;
const PRC_HEADER_SIZE = 16;
const PRC_RECORD_START = 20;
const PRC_RECORD_SIZE = 396;
const MASK_MAGIC = Buffer.from([0x51, 0x51, 0x46, 0x1a, 0x4d, 0x41, 0x53, 0x4b]);
const MASK_HEADER_SIZE = 32;
const MAX_MASK_FILE_BYTES = MAX_MASK_SOURCE_CELLS + 1024 * 1024;
const MAX_MONSTER_TABLE_BYTES = 16 * 1024 * 1024;
const MAX_MONSTER_ROWS = 32768;
const gbkFatal = new TextDecoder('gbk', { fatal: true });

function issue(issues, path, reason) {
  if (issues.length < MAX_ISSUES) issues.push({ path, reason });
  else if (issues.length === MAX_ISSUES) issues.push({ reason: '后续问题过多，已省略' });
}

function asBuffer(value, path) {
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(`${path} 读取结果不是二进制数据`);
}

function readRelatedSafe(readRelated, path, issues) {
  return Promise.resolve()
    .then(() => readRelated(path))
    .then((value) => value == null ? { data: null, failed: false } : { data: asBuffer(value, path), failed: false })
    .catch((error) => {
      issue(issues, path, `读取失败：${error?.message || String(error)}`);
      return { data: null, failed: true };
    });
}

function decodeGbk(buffer, path) {
  if (buffer.length > MAX_TEXT_BYTES) throw new Error(`${path} 超过 2 MiB 文本上限`);
  try {
    return gbkFatal.decode(buffer).replace(/\r\n?/g, '\n');
  } catch {
    throw new Error(`${path} 含无效 GBK 字节`);
  }
}

function int32(value) {
  if (!/^[+-]?\d+$/.test(value)) return null;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < -2147483648 || number > 2147483647) return null;
  return number;
}

function floatNumber(value) {
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= MAX_COORDINATE ? number : null;
}

// Resolve map IDs with GameBootstrap.MapSourceName and CustomMaps.SrcOf's exact normalization.
function sourceMapName(mapId, mapDefinitions) {
  const normalized = mapId >= 100000 ? Math.trunc(mapId / 1000) : mapId;
  const sourceId = normalized >= 90000 && normalized <= 99999 ? normalized - 90000 : normalized;
  const descriptor = mapDefinitions.get(sourceId);
  const fallback = `qw${String(sourceId).padStart(4, '0')}`;
  return {
    file: descriptor?.file || fallback,
    name: descriptor?.name || '',
    found: Boolean(descriptor?.file),
    sourceId,
  };
}

// MapDef.cs Parse accepts GBK [MapDef] sections with MapID/File/Name/IsCity fields.
function parseMapDefinitions(buffer, path, issues) {
  const text = decodeGbk(buffer, path);
  const definitions = new Map();
  let inMapDef = false;
  let current = { id: 0, file: '', name: '' };
  const commit = () => {
    if (inMapDef && current.id > 0) definitions.set(current.id, current);
  };
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith(';') || line.startsWith('#')) continue;
    if (line.startsWith('[')) {
      commit();
      current = { id: 0, file: '', name: '' };
      inMapDef = line.toLowerCase() === '[mapdef]';
      continue;
    }
    if (!inMapDef) continue;
    const split = line.indexOf('=');
    if (split < 1) continue;
    const key = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).split(';', 1)[0].trim();
    if (key === 'mapid') current.id = int32(value) || 0;
    else if (key === 'file') {
      if (/^[a-z0-9_-]{1,64}$/i.test(value)) current.file = value;
      else issue(issues, path, `地图 ID ${current.id} 的 file 字段无效，已使用客户端源名回退`);
    }
    else if (key === 'name') current.name = value;
  }
  commit();
  return definitions;
}

// ovplan-preview's manifest-validated ov_cmon plan is the field-layout authority here.
function parseMonsterIndex(buffer, path, neededIds, issues) {
  if (buffer.length > MAX_MONSTER_TABLE_BYTES) throw new Error('ov_cmon.bin 超过 16 MiB 上限');
  if (buffer.length < 16 || buffer.readUInt32LE(0) !== 0x5566) throw new Error('ov_cmon.bin 表头签名无效');
  if (ovManifest.formatVersion !== 1 || ovManifest.tableVersion !== 1 || buffer.readUInt32LE(4) !== ovManifest.tableVersion) {
    throw new Error('ov_cmon.bin 表版本与已集成清单不符');
  }
  const recordSize = buffer.readUInt32LE(8);
  const count = buffer.readUInt32LE(12);
  const expectedRecordSize = ovManifest.recordSizes?.ov_cmon;
  if (!Number.isSafeInteger(expectedRecordSize) || recordSize !== expectedRecordSize ||
      count > MAX_MONSTER_ROWS || 16 + recordSize * count !== buffer.length) {
    throw new Error('ov_cmon.bin 记录长度或数量无效');
  }
  const plan = plannedFields('ov_cmon.bin', recordSize);
  if (plan?.status !== 'loader' || !Array.isArray(plan.fields)) {
    throw new Error(plan?.message || 'ov_cmon.bin 缺少可用的已验证字段计划');
  }
  const field = (name, size, presentation) => {
    const match = plan.fields.find((candidate) => candidate.name === name);
    if (!match || match.size !== size || match.presentation !== presentation) {
      throw new Error(`ov_cmon.bin 字段计划中的 ${name} 布局不符合预期`);
    }
    return match;
  };
  const indexField = field('index', 4, 'int32');
  const mapIdField = field('map_id', 4, 'int32');
  const nameField = field('name', 32, 'gbk');
  const monsters = new Map();
  for (let index = 0; index < count; index++) {
    const offset = 16 + index * recordSize;
    const id = buffer.readInt32LE(offset + indexField.offset);
    if (!neededIds.has(id) || monsters.has(id)) continue;
    const mapId = buffer.readInt32LE(offset + mapIdField.offset);
    const nameBytes = buffer.subarray(offset + nameField.offset, offset + nameField.offset + nameField.size);
    const nul = nameBytes.indexOf(0);
    let name = '';
    try {
      name = gbkFatal.decode(nul < 0 ? nameBytes : nameBytes.subarray(0, nul));
    } catch {
      issue(issues, path, `怪物记录 ${id} 名称字段不是有效 GBK`);
    }
    monsters.set(id, { id, mapId, name });
  }
  return monsters;
}

// Use the polygon's shoelace centroid as a bounded world-coordinate label anchor.
function polygonCenter(polygon) {
  let twiceArea = 0;
  let xWeighted = 0;
  let yWeighted = 0;
  for (let index = 0; index < polygon.length; index++) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    xWeighted += (x1 + x2) * cross;
    yWeighted += (y1 + y2) * cross;
  }
  if (twiceArea !== 0) {
    const center = [xWeighted / (3 * twiceArea), yWeighted / (3 * twiceArea)];
    if (center.every(Number.isFinite) && center.every((value) => Math.abs(value) <= MAX_COORDINATE)) return center;
  }
  const minX = Math.min(...polygon.map(([x]) => x));
  const maxX = Math.max(...polygon.map(([x]) => x));
  const minY = Math.min(...polygon.map(([, y]) => y));
  const maxY = Math.max(...polygon.map(([, y]) => y));
  return [(minX + maxX) / 2, (minY + maxY) / 2];
}

// MapLink.Legacy.cs Load and proc-preview.cjs establish the QQF PROC v65537 record offsets.
function parsePrc(buffer) {
  if (buffer.length > MAX_PRC_BYTES) throw new Error('PRC 超过 32 MiB 上限');
  if (buffer.length < PRC_RECORD_START) throw new Error('PRC 文件头被截断');
  if (!buffer.subarray(0, 8).equals(PRC_MAGIC)) throw new Error('PRC 签名不是 QQF PROC');
  const version = buffer.readInt32LE(8);
  const headerSize = buffer.readInt32LE(12);
  if (version !== PRC_VERSION) throw new Error(`不支持 PRC 版本 ${version}`);
  if (headerSize !== PRC_HEADER_SIZE) throw new Error(`不支持 PRC 文件头长度 ${headerSize}`);
  const count = buffer.readInt32LE(16);
  if (count < 0 || count > MAX_MARKERS) throw new Error(`PRC 记录数超过 ${MAX_MARKERS} 上限：${count}`);
  const tableBytes = count * PRC_RECORD_SIZE;
  if (!Number.isSafeInteger(tableBytes) || tableBytes > buffer.length - PRC_RECORD_START) {
    throw new Error('PRC 记录表超出文件范围');
  }
  const records = [];
  for (let index = 0; index < count; index++) {
    const base = PRC_RECORD_START + index * PRC_RECORD_SIZE;
    const id = buffer.readInt32LE(base);
    const pointCount = buffer.readInt32LE(base + 8);
    if (pointCount < 3 || pointCount > MAX_POLYGON_POINTS) {
      records.push({ index, id, pointCount, polygon: null, reason: `顶点数 ${pointCount} 不在 3..${MAX_POLYGON_POINTS}` });
      continue;
    }
    const polygon = [];
    let invalid = false;
    for (let point = 0; point < pointCount; point++) {
      const x = buffer.readInt32LE(base + 44 + point * 4);
      const y = buffer.readInt32LE(base + 108 + point * 4);
      if (Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE) invalid = true;
      polygon.push([x, y]);
    }
    records.push({
      index,
      id,
      pointCount,
      polygon: invalid ? null : polygon,
      reason: invalid ? `坐标超出 ±${MAX_COORDINATE}` : null,
    });
  }
  return { version, count, records };
}

// MapLink.Legacy.cs Load consumes proc_id, map_to, map_to_pos and map_to_dir from GBK text.
function parseLink(buffer, path, issues) {
  const text = decodeGbk(buffer, path);
  const byProc = new Map();
  let current = null;
  const flush = () => {
    if (current && current.mapTo > 0) {
      const bucket = byProc.get(current.procId) || [];
      bucket.push(current);
      byProc.set(current.procId, bucket);
    }
    current = null;
  };
  for (const [lineIndex, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/[ \t]+/).filter(Boolean);
    if (tokens.length < 2) continue;
    const key = tokens[0].toLowerCase();
    if (key === 'proc_id') {
      flush();
      const procId = int32(tokens[1]);
      if (procId == null) {
        issue(issues, path, `第 ${lineIndex + 1} 行 proc_id 无效`);
        continue;
      }
      current = { procId, mapTo: -1, toX: 0, toY: 0, toDir: 0 };
    } else if (current && key === 'map_to') {
      const mapTo = int32(tokens[1]);
      if (mapTo == null) {
        issue(issues, path, `第 ${lineIndex + 1} 行 map_to 无效`);
        current.mapTo = -1;
      } else current.mapTo = mapTo;
    } else if (current && key === 'map_to_pos' && tokens.length >= 3) {
      const x = int32(tokens[1]);
      const y = int32(tokens[2]);
      if (x == null || y == null) {
        issue(issues, path, `第 ${lineIndex + 1} 行 map_to_pos 无效`);
        current.toX = 0;
        current.toY = 0;
      } else [current.toX, current.toY] = [x, y];
    } else if (current && key === 'map_to_dir') {
      const direction = int32(tokens[1]);
      if (direction == null) {
        issue(issues, path, `第 ${lineIndex + 1} 行 map_to_dir 无效`);
        current.toDir = 0;
      } else current.toDir = direction;
    }
  }
  flush();
  return byProc;
}

function transferMarker(proc, transfer, prcPath, linkPath, destination) {
  const center = polygonCenter(proc.polygon);
  const displayTarget = destination.name || `地图 ID ${transfer.mapTo}`;
  return {
    id: `transfer-${proc.id}-${proc.index}`,
    kind: 'transfer',
    label: `传送区域 ${proc.id} → ${displayTarget}`,
    x: center[0],
    y: center[1],
    polygon: proc.polygon,
    path: prcPath,
    links: [
      { label: `传送配置：${linkPath}`, path: linkPath },
      { label: `目标地图：${destination.file}.gsm`, path: `map/${destination.file}.gsm` },
    ],
    details: `区域编号 ${proc.id}；多边形几何中心锚点 (${center[0]}, ${center[1]})；目标地图 ID ${transfer.mapTo}${destination.name ? `（${destination.name}）` : ''}；目标坐标 (${transfer.toX}, ${transfer.toY})；朝向 ${transfer.toDir}.${destination.found ? '' : ` map.def 未提供目标描述；源名按 MapSourceName 的官方回退规则为 ${destination.file}。`}`,
  };
}

// MapNpc.cs Parse/FlushAndReset keeps [Npc] sections with index > 0 and refreshType == 0.
function parseNpcs(buffer, path, issues) {
  const text = decodeGbk(buffer, path);
  const entries = [];
  let current = null;
  const flush = () => {
    if (current && current.index > 0 && current.refreshType === 0) entries.push(current);
    if (entries.length > MAX_MARKERS) throw new Error(`NPC 配置条目超过 ${MAX_MARKERS} 上限`);
    current = null;
  };
  for (const [lineIndex, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      flush();
      if (line.toLowerCase() === '[npc]') {
        current = { name: '', x: 0, y: 0, index: 0, refreshType: 0, script: '', sell: 0, trans: 0 };
      }
      continue;
    }
    if (!current) continue;
    const split = line.indexOf('=');
    if (split <= 0) continue;
    const key = line.slice(0, split).trim().toLowerCase();
    const value = line.slice(split + 1).trim();
    if (key === 'name') current.name = value;
    else if (key === 'init_pos') {
      const pair = value.split(',');
      if (pair.length >= 2) {
        const x = floatNumber(pair[0].trim());
        const y = floatNumber(pair[1].trim());
        if (x != null && y != null) {
          current.x = x;
          current.y = y;
        } else issue(issues, path, `第 ${lineIndex + 1} 行 init_pos 无效`);
      }
    } else if (key === 'index' || key === 'refreshtype' || key === 'selllist' || key === 'translist') {
      const parsed = int32(value);
      if (parsed == null) {
        issue(issues, path, `第 ${lineIndex + 1} 行 ${key} 无效`);
        if (key === 'index') current.index = 0;
        else if (key === 'refreshtype') current.refreshType = 0;
        else if (key === 'selllist') current.sell = 0;
        else current.trans = 0;
      } else if (key === 'index') current.index = parsed;
      else if (key === 'refreshtype') current.refreshType = parsed;
      else if (key === 'selllist') current.sell = parsed;
      else current.trans = parsed;
    } else if (key === 'script') current.script = value;
  }
  flush();
  return entries;
}

// server/internal/data/mapfiles.go ParseSpawnFile documents .lst id/index/init_pos/init_dir.
function parseSpawns(buffer, path, issues) {
  const text = decodeGbk(buffer, path);
  const entries = [];
  let current = null;
  const flush = () => {
    if (current) entries.push(current);
    if (entries.length > MAX_MARKERS) throw new Error(`刷新点超过 ${MAX_MARKERS} 上限`);
    current = null;
  };
  for (const [lineIndex, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const tokens = line.split(/\s+/);
    if (tokens.length < 2) continue;
    const key = tokens[0];
    if (key === 'id') {
      flush();
      const id = int32(tokens[1]);
      if (id == null) {
        issue(issues, path, `第 ${lineIndex + 1} 行 id 无效`);
        continue;
      }
      current = { id, monster: 0, x: 0, y: 0, dir: 0 };
    } else if (current && (key === 'index' || key === 'init_dir')) {
      const value = int32(tokens[1]);
      if (value == null) {
        issue(issues, path, `第 ${lineIndex + 1} 行 ${key} 无效`);
        if (key === 'index') current.monster = 0;
        else current.dir = 0;
      } else if (key === 'index') current.monster = value;
      else current.dir = value;
    } else if (current && key === 'init_pos') {
      const x = int32(tokens[1]);
      const y = int32(tokens[2]);
      if (x == null || y == null) {
        issue(issues, path, `第 ${lineIndex + 1} 行 init_pos 无效`);
        current.x = 0;
        current.y = 0;
      } else [current.x, current.y] = [x, y];
    }
  }
  flush();
  return entries;
}

// ReferenceWorldCollisionMask.TryParse reads QQF MASK dimensions/cell sizes and trailing W*H cells.
function parseMask(buffer) {
  if (buffer.length > MAX_MASK_FILE_BYTES) throw new Error('MSK 超过 33 MiB 安全上限');
  if (buffer.length < MASK_HEADER_SIZE) throw new Error('MSK 文件头被截断');
  if (!buffer.subarray(0, 8).equals(MASK_MAGIC)) throw new Error('MSK 签名不是 QQF MASK');
  const width = buffer.readInt32LE(16);
  const height = buffer.readInt32LE(20);
  if (width < 1 || height < 1) throw new Error('MSK 宽高无效');
  const cellCount = width * height;
  if (!Number.isSafeInteger(cellCount) || cellCount > MAX_MASK_SOURCE_CELLS || cellCount > buffer.length - MASK_HEADER_SIZE) {
    throw new Error('MSK 单元数据超出文件范围');
  }
  const offset = buffer.length - cellCount;
  if (offset < MASK_HEADER_SIZE) throw new Error('MSK 尾部单元数据与文件头重叠');
  let cellWidth = buffer.readInt32LE(24);
  let cellHeight = buffer.readInt32LE(28);
  if (cellWidth < 1) cellWidth = 10;
  if (cellHeight < 1) cellHeight = 10;
  if (!Number.isSafeInteger(width * cellWidth) || !Number.isSafeInteger(height * cellHeight)) {
    throw new Error('MSK 世界尺寸超出安全整数范围');
  }
  return { width, height, cellWidth, cellHeight, offset };
}

function renderMask(buffer, mask) {
  const factor = Math.max(1, Math.ceil(mask.width / MAX_MASK_SIDE), Math.ceil(mask.height / MAX_MASK_SIDE),
    Math.ceil(Math.sqrt((mask.width * mask.height) / MAX_MASK_PIXELS)));
  const width = Math.ceil(mask.width / factor);
  const height = Math.ceil(mask.height / factor);
  if (width > MAX_MASK_SIDE || height > MAX_MASK_SIDE || width * height > MAX_MASK_PIXELS) {
    throw new Error('MSK 缩放后仍超过 PNG 像素上限');
  }
  const png = new PNG({ width, height });
  const cells = buffer.subarray(mask.offset);
  for (let outY = 0; outY < height; outY++) {
    for (let outX = 0; outX < width; outX++) {
      const xStart = Math.floor(outX * mask.width / width);
      const xEnd = Math.min(mask.width, Math.ceil((outX + 1) * mask.width / width));
      let blocked = false;
      const yStart = Math.floor(outY * mask.height / height);
      const yEnd = Math.min(mask.height, Math.ceil((outY + 1) * mask.height / height));
      for (let y = yStart; y < yEnd && !blocked; y++) {
        for (let x = xStart; x < xEnd; x++) {
          if ((cells[y * mask.width + x] & 0x80) !== 0) {
            blocked = true;
            break;
          }
        }
      }
      if (blocked) {
        const pixel = (outY * width + outX) * 4;
        png.data[pixel] = 255;
        png.data[pixel + 1] = 32;
        png.data[pixel + 2] = 32;
        png.data[pixel + 3] = 180;
      }
    }
  }
  return {
    base64: PNG.sync.write(png, { deflateLevel: 9 }).toString('base64'),
    mime: 'image/png',
    width,
    height,
    worldWidth: mask.width * mask.cellWidth,
    worldHeight: mask.height * mask.cellHeight,
  };
}

async function readMapLogic(name, { readRelated } = {}) {
  const normalizedName = String(name ?? '').replace(/\\/g, '/').replace(/^map\//i, '');
  const basename = normalizedName.replace(/\.(?:gsm|prc|link|npc|lst|msk)$/i, '');
  const issues = [];
  if (!/^[a-z0-9_-]{1,64}$/i.test(basename)) {
    issue(issues, String(name ?? ''), '地图 basename 无效，未读取逻辑资源');
    return { markers: [], issues };
  }
  if (typeof readRelated !== 'function') {
    issue(issues, `map/${basename}`, '没有可用的关联资源读取回调');
    return { markers: [], issues };
  }
  const paths = Object.fromEntries(['prc', 'link', 'npc', 'lst', 'msk'].map((ext) => [ext, `map/${basename}.${ext}`]));
  const loaded = await Promise.all(
    Object.values(paths).map((path) => readRelatedSafe(readRelated, path, issues)),
  );
  const [prcBytes, linkBytes, npcBytes, lstBytes, mskBytes] = loaded.map((item) => item.data);
  for (const [ext, bytes] of Object.entries({ prc: prcBytes, link: linkBytes, npc: npcBytes, lst: lstBytes, msk: mskBytes })) {
    const index = Object.keys(paths).indexOf(ext);
    if (!bytes && !loaded[index].failed) issue(issues, paths[ext], '资源缺失');
  }

  const markers = [];
  let linkMap = new Map();
  if (linkBytes) {
    try {
      linkMap = parseLink(linkBytes, paths.link, issues);
    } catch (error) {
      issue(issues, paths.link, `损坏或不支持：${error.message}`);
    }
  }
  let prcRecords = [];
  if (prcBytes) {
    try {
      prcRecords = parsePrc(prcBytes).records;
    } catch (error) {
      issue(issues, paths.prc, `损坏或不支持：${error.message}`);
    }
  }

  const transferTargetIds = new Set();
  for (const record of prcRecords) {
    if (record.polygon && linkMap.has(record.id)) {
      for (const transfer of linkMap.get(record.id)) transferTargetIds.add(transfer.mapTo);
    }
  }
  let mapDefinitions = new Map();
  if (transferTargetIds.size > 0) {
    const mapDefPath = 'map/map.def';
    const mapDefRead = await readRelatedSafe(readRelated, mapDefPath, issues);
    if (!mapDefRead.data) {
      if (!mapDefRead.failed) issue(issues, mapDefPath, '资源缺失，传送目标名称按官方源名回退规则处理');
    } else {
      try {
        mapDefinitions = parseMapDefinitions(mapDefRead.data, mapDefPath, issues);
      } catch (error) {
        issue(issues, mapDefPath, `损坏或不支持：${error.message}`);
      }
    }
  }
  for (const record of prcRecords) {
    if (!record.polygon) {
      issue(issues, paths.prc, `区域 ${record.id}：${record.reason}`);
      continue;
    }
    const center = polygonCenter(record.polygon);
    const transfers = linkMap.get(record.id);
    if (transfers?.length) {
      for (const transfer of transfers) {
        if (markers.length >= MAX_MARKERS) {
          issue(issues, paths.prc, `逻辑标记超过 ${MAX_MARKERS} 上限`);
          break;
        }
        markers.push(transferMarker(record, transfer, paths.prc, paths.link, sourceMapName(transfer.mapTo, mapDefinitions)));
      }
    } else {
      if (markers.length >= MAX_MARKERS) {
        issue(issues, paths.prc, `逻辑标记超过 ${MAX_MARKERS} 上限`);
        break;
      }
      markers.push({
        id: `trigger-${record.id}-${record.index}`,
        kind: 'trigger',
        label: `触发区域 ${record.id}`,
        x: center[0],
        y: center[1],
        polygon: record.polygon,
        path: paths.prc,
        links: [],
        details: `区域编号 ${record.id}；多边形几何中心锚点 (${center[0]}, ${center[1]})；无传送目标的多边形由客户端作为采集区域使用。`,
      });
    }
  }

  if (npcBytes) {
    try {
      for (const npc of parseNpcs(npcBytes, paths.npc, issues)) {
        if (markers.length >= MAX_MARKERS) throw new Error(`逻辑标记超过 ${MAX_MARKERS} 上限`);
        const sprite = `npc${npc.index}`;
        const spritePath = `avatar/npc/${sprite}01.gsn`;
        markers.push({
          id: `npc-${npc.index}-${markers.length}`,
          kind: 'npc',
          label: npc.name || sprite,
          x: npc.x,
          y: npc.y,
          path: paths.npc,
          links: [{ label: `NPC 形象 ${sprite}`, path: spritePath }],
          details: `NPC ${npc.name || sprite}；sprite=${sprite}；位置 (${npc.x}, ${npc.y})；脚本=${npc.script || '无'}；商店=${npc.sell}；传送列表=${npc.trans}。`,
        });
      }
    } catch (error) {
      issue(issues, paths.npc, `损坏或不支持：${error.message}`);
    }
  }

  let spawnEntries = [];
  if (lstBytes) {
    try {
      spawnEntries = parseSpawns(lstBytes, paths.lst, issues);
    } catch (error) {
      issue(issues, paths.lst, `损坏或不支持：${error.message}`);
    }
  }

  let monsters = new Map();
  let monsterTableLoaded = false;
  if (spawnEntries.length > 0) {
    const monsterPath = 'zipbin/ov_cmon.bin';
    const monsterRead = await readRelatedSafe(readRelated, monsterPath, issues);
    if (!monsterRead.data) {
      if (!monsterRead.failed) issue(issues, monsterPath, '资源缺失，刷新点保留怪物编号');
    } else {
      try {
        const neededIds = new Set(spawnEntries.map((spawn) => spawn.monster));
        monsters = parseMonsterIndex(monsterRead.data, monsterPath, neededIds, issues);
        monsterTableLoaded = true;
      } catch (error) {
        issue(issues, monsterPath, `损坏或不支持：${error.message}`);
      }
    }
  }
  for (const spawn of spawnEntries) {
    if (markers.length >= MAX_MARKERS) {
      issue(issues, paths.lst, `逻辑标记超过 ${MAX_MARKERS} 上限`);
      break;
    }
    const monster = monsters.get(spawn.monster);
    if (!monster && monsterTableLoaded) issue(issues, 'zipbin/ov_cmon.bin', `未找到怪物编号 ${spawn.monster}`);
    const name = monster?.name || `怪物编号 ${spawn.monster}`;
    const links = [];
    if (monster) {
      links.push({ label: `怪物数据：zipbin/ov_cmon.bin`, path: 'zipbin/ov_cmon.bin' });
    }
    markers.push({
      id: `spawn-${spawn.id}`,
      kind: 'spawn',
      label: `怪物刷新点 ${spawn.id}：${name}`,
      x: spawn.x,
      y: spawn.y,
      path: paths.lst,
      links,
      details: `刷新点编号 ${spawn.id}；怪物表编号 ${spawn.monster}${monster ? `；名称 ${monster.name || '未知'}；map_id ${monster.mapId}（客户端形象关联未证实）` : ''}；位置 (${spawn.x}, ${spawn.y})；朝向 ${spawn.dir}。`,
    });
  }

  let collision;
  if (mskBytes) {
    try {
      const mask = parseMask(mskBytes);
      collision = renderMask(mskBytes, mask);
    } catch (error) {
      issue(issues, paths.msk, `损坏或不支持：${error.message}`);
    }
  }

  return { markers, collision, issues };
}

module.exports = {
  readMapLogic,
  parsePrc,
  parseLink,
  parseNpcs,
  parseSpawns,
  parseMapDefinitions,
  sourceMapName,
  parseMonsterIndex,
};
