'use strict';

const { PNG } = require('pngjs');
const {
  parsePrc,
  parseLink,
  parseNpcs,
  parseSpawns,
  parseMapDefinitions,
  sourceMapName,
  parseMonsterIndex,
} = require('./map-logic.cjs');

const PAGE_SIZE = 50;
const MAX_RECORDS = 10000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1024;
const MAX_IMAGE_PIXELS = 4 * 1024 * 1024;
const gbkFatal = new TextDecoder('gbk', { fatal: true });

function fail(message) {
  throw new Error(`地图资源预览失败：${message}`);
}

function readBuffer(buffer) {
  if (Buffer.isBuffer(buffer)) return buffer;
  if (buffer instanceof Uint8Array) return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  fail('输入不是二进制数据');
}

function safePathName(name) {
  const normalized = String(name ?? '').replace(/\\/g, '/').replace(/^map\//i, '');
  const match = /^([a-z0-9_-]{1,64})\.(prc|link|npc|lst)$/i.exec(normalized);
  return match ? { basename: match[1], extension: match[2].toLowerCase() } : null;
}

function safeGbk(buffer) {
  if (buffer.length > MAX_TEXT_BYTES) fail('文本资源超过 2 MiB 上限');
  try {
    return gbkFatal.decode(buffer).replace(/\r\n?/g, '\n');
  } catch {
    fail('文本资源含无效 GBK 字节');
  }
}

function recognizedNpcConfig(text) {
  let inNpc = false;
  let recognized = false;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    if (line.startsWith('[')) {
      inNpc = line.toLowerCase() === '[npc]';
      continue;
    }
    if (!inNpc) continue;
    const split = line.indexOf('=');
    if (split < 1) continue;
    const key = line.slice(0, split).trim().toLowerCase();
    if (['name', 'init_pos', 'script', 'selllist', 'translist', 'index', 'refreshtype'].includes(key)) {
      recognized = true;
      break;
    }
  }
  return recognized;
}

function recognizedSpawnConfig(text) {
  return text.split('\n').some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return false;
    const key = line.split(/\s+/, 1)[0];
    return ['id', 'index', 'init_pos', 'init_dir'].includes(key);
  });
}

function recognizedLinkConfig(text) {
  return text.split('\n').some((raw) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return false;
    const key = line.split(/[ \t]+/, 1)[0].toLowerCase();
    return ['proc_id', 'map_to', 'map_to_pos', 'map_to_dir'].includes(key);
  });
}

function hasNonCommentContent(text, prefixes) {
  return text.split('\n').some((raw) => {
    const line = raw.trim();
    return line.length > 0 && !prefixes.some((prefix) => line.startsWith(prefix));
  });
}

function collectIssues(issues) {
  return issues.map((item) => `${item.path ? `${item.path}：` : ''}${item.reason}`).join('；');
}

async function readOptional(readRelated, path) {
  if (typeof readRelated !== 'function') return { data: null, reason: '没有关联资源读取回调' };
  try {
    const result = await readRelated(path);
    if (result == null) return { data: null, reason: `缺少 ${path}` };
    if (Buffer.isBuffer(result)) return { data: result, reason: '' };
    if (result instanceof Uint8Array) {
      return { data: Buffer.from(result.buffer, result.byteOffset, result.byteLength), reason: '' };
    }
    return { data: null, reason: `${path} 读取结果不是二进制数据` };
  } catch (error) {
    return { data: null, reason: `${path} 读取失败：${error?.message || String(error)}` };
  }
}

function pageResult(rows, columns, page, info, image) {
  const rowCount = rows.length;
  const pageCount = Math.max(1, Math.ceil(rowCount / PAGE_SIZE));
  if (!Number.isSafeInteger(page) || page < 0 || page >= pageCount) fail(`页码超出范围（共 ${pageCount} 页）`);
  const first = page * PAGE_SIZE;
  return {
    kind: 'resource-records',
    columns,
    rows: rows.slice(first, first + PAGE_SIZE),
    page,
    pageCount,
    rowCount,
    info,
    ...(image ? { image } : {}),
  };
}

function polygonBounds(records) {
  const valid = records.filter((record) => Array.isArray(record.polygon));
  if (!valid.length) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const record of valid) {
    for (const [x, y] of record.polygon) {
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  return { minX, minY, maxX, maxY, width: Math.max(1, maxX - minX), height: Math.max(1, maxY - minY) };
}

function colorFor(index) {
  const hue = (index * 137.508) % 360;
  const saturation = 0.78;
  const lightness = 0.56;
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const second = chroma * (1 - Math.abs(section % 2 - 1));
  const [red, green, blue] = section < 1 ? [chroma, second, 0]
    : section < 2 ? [second, chroma, 0]
      : section < 3 ? [0, chroma, second]
        : section < 4 ? [0, second, chroma]
          : section < 5 ? [second, 0, chroma]
            : [chroma, 0, second];
  const offset = lightness - chroma / 2;
  const channels = [red, green, blue].map((value) => Math.round((value + offset) * 255));
  return { channels, hex: `#${channels.map((value) => value.toString(16).padStart(2, '0')).join('')}` };
}

function drawLine(png, from, to, color) {
  let [x0, y0] = from;
  const [x1, y1] = to;
  const dx = Math.abs(x1 - x0);
  const sx = x0 < x1 ? 1 : -1;
  const dy = -Math.abs(y1 - y0);
  const sy = y0 < y1 ? 1 : -1;
  let error = dx + dy;
  while (true) {
    if (x0 >= 0 && y0 >= 0 && x0 < png.width && y0 < png.height) {
      const pixel = (y0 * png.width + x0) * 4;
      png.data[pixel] = color[0];
      png.data[pixel + 1] = color[1];
      png.data[pixel + 2] = color[2];
      png.data[pixel + 3] = 255;
    }
    if (x0 === x1 && y0 === y1) break;
    const twice = error * 2;
    if (twice >= dy) { error += dy; x0 += sx; }
    if (twice <= dx) { error += dx; y0 += sy; }
  }
}

const GLYPHS = {
  '0': ['111', '101', '101', '101', '111'],
  '1': ['010', '110', '010', '010', '111'],
  '2': ['111', '001', '111', '100', '111'],
  '3': ['111', '001', '111', '001', '111'],
  '4': ['101', '101', '111', '001', '001'],
  '5': ['111', '100', '111', '001', '111'],
  '6': ['111', '100', '111', '101', '111'],
  '7': ['111', '001', '010', '010', '010'],
  '8': ['111', '101', '111', '101', '111'],
  '9': ['111', '101', '111', '001', '111'],
  '-': ['000', '000', '111', '000', '000'],
};

function polygonCentroid(polygon) {
  let twiceArea = 0;
  let weightedX = 0;
  let weightedY = 0;
  for (let index = 0; index < polygon.length; index++) {
    const [x1, y1] = polygon[index];
    const [x2, y2] = polygon[(index + 1) % polygon.length];
    const cross = x1 * y2 - x2 * y1;
    twiceArea += cross;
    weightedX += (x1 + x2) * cross;
    weightedY += (y1 + y2) * cross;
  }
  if (twiceArea !== 0) return [weightedX / (3 * twiceArea), weightedY / (3 * twiceArea)];
  return [
    polygon.reduce((total, point) => total + point[0], 0) / polygon.length,
    polygon.reduce((total, point) => total + point[1], 0) / polygon.length,
  ];
}

function drawRegionId(png, text, centerX, centerY) {
  const glyphWidth = 3;
  const spacing = 1;
  const textWidth = text.length * (glyphWidth + spacing) - spacing;
  const left = Math.max(0, Math.min(png.width - textWidth, Math.round(centerX - textWidth / 2)));
  const top = Math.max(0, Math.min(png.height - 5, Math.round(centerY - 2)));
  const paint = (x, y, color) => {
    if (x < 0 || y < 0 || x >= png.width || y >= png.height) return;
    const offset = (y * png.width + x) * 4;
    png.data[offset] = color[0];
    png.data[offset + 1] = color[1];
    png.data[offset + 2] = color[2];
    png.data[offset + 3] = 255;
  };
  const pixels = [];
  for (let charIndex = 0; charIndex < text.length; charIndex++) {
    const glyph = GLYPHS[text[charIndex]];
    if (!glyph) continue;
    for (let y = 0; y < 5; y++) {
      for (let x = 0; x < glyphWidth; x++) {
        if (glyph[y][x] !== '1') continue;
        const px = left + charIndex * (glyphWidth + spacing) + x;
        const py = top + y;
        pixels.push([px, py]);
      }
    }
  }
  for (const [px, py] of pixels) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) paint(px + dx, py + dy, [0, 0, 0]);
    }
  }
  for (const [px, py] of pixels) paint(px, py, [255, 255, 255]);
}

function renderPolygons(records, page) {
  const bounds = polygonBounds(records);
  if (!bounds) return null;
  const padding = 8;
  const available = MAX_IMAGE_SIDE - padding * 2;
  const scale = Math.min(available / bounds.width, available / bounds.height);
  const contentWidth = Math.max(1, Math.min(MAX_IMAGE_SIDE, Math.ceil(bounds.width * scale) + padding * 2));
  const contentHeight = Math.max(1, Math.min(MAX_IMAGE_SIDE, Math.ceil(bounds.height * scale) + padding * 2));
  const width = Math.max(contentWidth, 64);
  const height = Math.max(contentHeight, 24);
  const offsetX = Math.floor((width - contentWidth) / 2);
  const offsetY = Math.floor((height - contentHeight) / 2);
  if (width * height > MAX_IMAGE_PIXELS) fail('PRC PNG 超过像素上限');
  const png = new PNG({ width, height });
  const start = page * PAGE_SIZE;
  const end = Math.min(records.length, start + PAGE_SIZE);
  const labels = [];
  for (let recordIndex = start; recordIndex < end; recordIndex++) {
    const record = records[recordIndex];
    if (!Array.isArray(record.polygon)) continue;
    const palette = colorFor(record.index);
    const points = record.polygon.map(([x, y]) => [
      offsetX + padding + Math.round((x - bounds.minX) * scale),
      height - offsetY - padding - Math.round((y - bounds.minY) * scale),
    ]);
    for (let index = 0; index < points.length; index++) {
      drawLine(png, points[index], points[(index + 1) % points.length], palette.channels);
    }
    const center = polygonCentroid(record.polygon);
    const centerX = offsetX + padding + Math.round((center[0] - bounds.minX) * scale);
    const centerY = height - offsetY - padding - Math.round((center[1] - bounds.minY) * scale);
    labels.push({ id: record.id, x: centerX, y: centerY });
  }
  for (const label of labels) drawRegionId(png, String(label.id), label.x, label.y);
  return {
    base64: PNG.sync.write(png, { deflateLevel: 9 }).toString('base64'),
    mime: 'image/png',
    width,
    height,
  };
}

async function makeWorldResourcePreview(buffer, name, options = {}) {
  const identity = safePathName(name);
  if (!identity) return null;
  const bytes = readBuffer(buffer);
  if (!options || typeof options !== 'object' || Array.isArray(options)) fail('预览参数无效');
  const page = options.page === undefined ? 0 : options.page;
  if (!Number.isSafeInteger(page) || page < 0) fail('页码必须是非负安全整数');
  const { basename, extension } = identity;
  const sourcePath = `map/${basename}.${extension}`;
  const readRelated = options.readRelated;

  if (extension === 'prc') {
    const records = parsePrc(bytes).records;
    const pageCount = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    if (page >= pageCount) fail(`页码超出范围（共 ${pageCount} 页）`);
    const rows = records.map((record) => ({
      id: `prc-${record.id}-${record.index}`,
      cells: [
        String(record.id),
        record.polygon ? String(record.polygon.length) : `无效：${record.reason}`,
        record.polygon ? record.polygon.map(([x, y]) => `(${x}, ${y})`).join(' ') : '',
        colorFor(record.index).hex,
      ],
      links: [],
    }));
    const image = renderPolygons(records, page);
    const info = `QQF PROC v65537；本页最多 ${PAGE_SIZE} 个区域；PNG 只绘制本页多边形轮廓，所有页共用全文件坐标范围，X 向右、Y 向上；颜色与表格“轮廓颜色”对应。${records.length} 条记录。`;
    return pageResult(rows, [
      { key: 'region', label: '区域 ID' },
      { key: 'vertices', label: '顶点数' },
      { key: 'coordinates', label: '原始坐标' },
      { key: 'color', label: '轮廓颜色' },
    ], page, info, image);
  }

  if (extension === 'npc') {
    const issues = [];
    const text = safeGbk(bytes);
    if (hasNonCommentContent(text, ['#', ';']) && !recognizedNpcConfig(text)) fail('非空 NPC 文件未识别到客户端 [Npc] 配置语法');
    const records = parseNpcs(bytes, sourcePath, issues);
    if (records.length === 0 && issues.length > 0) fail(`NPC 文件没有有效静态配置：${collectIssues(issues)}`);
    const rows = records.map((record, index) => {
      const sprite = `npc${record.index}`;
      return {
        id: `npc-${record.index}-${index}`,
        cells: [record.name || sprite, `(${record.x}, ${record.y})`, record.script || '', String(record.sell), String(record.trans)],
        links: [{ label: `NPC 形象 ${sprite}`, path: `avatar/npc/${sprite}01.gsn` }],
      };
    });
    const note = collectIssues(issues);
    return pageResult(rows, [
      { key: 'name', label: 'NPC 名称' },
      { key: 'position', label: '坐标' },
      { key: 'script', label: '脚本' },
      { key: 'sell', label: '商店编号' },
      { key: 'trans', label: '传送列表编号' },
    ], page, `客户端 MapNpc.Parse：只显示 index>0 且 refreshType=0 的 [Npc] 配置；坐标保留原始单位。NPC GSN 路径由 ResLoader.LoadNpcFull 确认。${note ? ` 配置问题：${note}` : ''}`, null);
  }

  if (extension === 'lst') {
    const issues = [];
    const text = safeGbk(bytes);
    if (hasNonCommentContent(text, ['#']) && !recognizedSpawnConfig(text)) fail('非空 LST 文件未识别到刷新点记录语法');
    const records = parseSpawns(bytes, sourcePath, issues);
    if (records.length === 0 && hasNonCommentContent(text, ['#'])) {
      fail('LST 文件含非注释内容，但没有有效刷新点记录');
    }
    let monsters = new Map();
    let dependencyNote = '';
    if (records.length > 0) {
      const resource = await readOptional(readRelated, 'zipbin/ov_cmon.bin');
      if (!resource.data) dependencyNote = resource.reason;
      else {
        try {
          monsters = parseMonsterIndex(resource.data, 'zipbin/ov_cmon.bin', new Set(records.map((record) => record.monster)), issues);
          for (const record of records) {
            if (!monsters.has(record.monster)) issues.push({ path: 'zipbin/ov_cmon.bin', reason: `未找到怪物编号 ${record.monster}` });
          }
        } catch (error) {
          dependencyNote = `怪物表无法解析：${error.message}`;
        }
      }
    }
    const rows = records.map((record) => {
      const monster = monsters.get(record.monster);
      return {
        id: `spawn-${record.id}`,
        cells: [String(record.id), String(record.monster), monster?.name || '', `(${record.x}, ${record.y})`, String(record.dir)],
        links: monster ? [{ label: '怪物数据：zipbin/ov_cmon.bin', path: 'zipbin/ov_cmon.bin' }] : [],
      };
    });
    const note = [dependencyNote, collectIssues(issues)].filter(Boolean).join('；');
    return pageResult(rows, [
      { key: 'spawn', label: '刷新点编号' },
      { key: 'monster_id', label: '怪物编号' },
      { key: 'monster_name', label: '怪物名称' },
      { key: 'position', label: '坐标' },
      { key: 'direction', label: '朝向' },
    ], page, `服务端 ParseSpawnFile：每个 id/index/init_pos/init_dir 记录一个刷新点；坐标保留原始单位。怪物名称只从通过 ovplan/manifest 记录计划校验的 ov_cmon 读取；模型形象关系未证实。${note ? ` 关联信息：${note}` : ''}`, null);
  }

  if (extension === 'link') {
    const issues = [];
    const text = safeGbk(bytes);
    if (hasNonCommentContent(text, ['#']) && !recognizedLinkConfig(text)) fail('非空 LINK 文件未识别到传送配置语法');
    const transfers = parseLink(bytes, sourcePath, issues);
    if (transfers.size === 0 && issues.length > 0) fail(`LINK 文件没有有效传送配置：${collectIssues(issues)}`);
    const targets = [...transfers.values()].flat();
    if (hasNonCommentContent(text, ['#']) && targets.length === 0) fail('LINK 文件没有有效的正 map_to 传送记录');
    if (targets.length > MAX_RECORDS) fail(`LINK 传送配置超过 ${MAX_RECORDS} 条上限`);
    let definitions = new Map();
    let dependencyNote = '';
    if (targets.length > 0) {
      const resource = await readOptional(readRelated, 'map/map.def');
      if (!resource.data) dependencyNote = resource.reason;
      else {
        try {
          definitions = parseMapDefinitions(resource.data, 'map/map.def', issues);
          if (definitions.size > MAX_RECORDS) fail(`map.def 记录超过 ${MAX_RECORDS} 上限`);
        } catch (error) {
          dependencyNote = `map.def 无法解析：${error.message}`;
        }
      }
    }
    const rows = [];
    for (const [procId, procTransfers] of transfers) {
      for (let index = 0; index < procTransfers.length; index++) {
        const transfer = procTransfers[index];
        const destination = sourceMapName(transfer.mapTo, definitions);
        const label = destination.name || `地图 ID ${transfer.mapTo}`;
        rows.push({
          id: `link-${procId}-${index}`,
          cells: [String(procId), String(transfer.mapTo), label, `(${transfer.toX}, ${transfer.toY})`, String(transfer.toDir)],
          links: [{ label: `目标地图 ${destination.file}.gsm`, path: `map/${destination.file}.gsm` }],
        });
      }
    }
    const note = [dependencyNote, collectIssues(issues)].filter(Boolean).join('；');
    return pageResult(rows, [
      { key: 'region', label: '触发区域 ID' },
      { key: 'map_id', label: '目标地图 ID' },
      { key: 'map_name', label: '目标地图名称' },
      { key: 'position', label: '目标落点' },
      { key: 'direction', label: '目标朝向' },
    ], page, `仅列出 LINK 中声明的正 map_to 配置及其落点坐标/方向；这不是完整地图可达性或场景传送行为判定。MapDef 与 MapSourceName 用于目标地图名称和源文件，无法解析时保留 ID 并按客户端源名回退规则提供路径。LINK 不包含区域多边形，区域编号来自对应 PRC。${note ? ` 关联信息：${note}` : ''}`, null);
  }

  return null;
}

module.exports = { makeWorldResourcePreview, PAGE_SIZE, MAX_TEXT_BYTES };
