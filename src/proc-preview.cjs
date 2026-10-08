'use strict';

const PROC_MAGIC = Buffer.from([0x51, 0x51, 0x46, 0x1a, 0x50, 0x52, 0x4f, 0x43]);
const PROC_VERSION = 65537;
const HEADER_SIZE = 16;
const RECORD_START = 20;
const RECORD_SIZE = 396;
const ID_OFFSET = 0;
const POINT_COUNT_OFFSET = 8;
const POINT_X_OFFSET = 44;
const POINT_Y_OFFSET = 108;
const MAX_POINTS = 16;
const MIN_POINTS = 3;
const MAX_INPUT_BYTES = 32 * 1024 * 1024;
const MAX_RECORDS = 100000;
const PAGE_SIZE = 32;
const MAX_COORDINATE = 10000000;

// Check the bounded binary input before reading any header field.
function ensureBuffer(buffer) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('buffer must be a Buffer');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('PRC exceeds the 32 MiB preview limit');
}

// Validate the evidence-backed QQF PROC signature, version and header size.
function readHeader(buffer) {
  if (buffer.length < RECORD_START) throw new Error('PRC header is truncated');
  if (!buffer.subarray(0, PROC_MAGIC.length).equals(PROC_MAGIC)) {
    throw new Error('unsupported PRC signature; expected QQF PROC');
  }
  const version = buffer.readInt32LE(8);
  const headerSize = buffer.readInt32LE(12);
  if (version !== PROC_VERSION) throw new Error(`unsupported PRC version ${version}`);
  if (headerSize !== HEADER_SIZE) throw new Error(`unsupported PRC header size ${headerSize}`);
  const count = buffer.readInt32LE(16);
  if (count < 0 || count > MAX_RECORDS) throw new Error(`invalid PRC record count ${count}`);
  const recordsBytes = count * RECORD_SIZE;
  if (!Number.isSafeInteger(recordsBytes) || recordsBytes > buffer.length - RECORD_START) {
    throw new Error('PRC record table is truncated or exceeds the file boundary');
  }
  return { version, headerSize, count };
}

// ReferenceAssets/ReferenceWorldMapLinks.cs defines PROC_HEAD/SIZE and OFF_PN/PX/PY.
// MapLink.Legacy.cs Load reads only these polygon fields from each record.
function readRecord(buffer, index) {
  const base = RECORD_START + index * RECORD_SIZE;
  if (!Number.isSafeInteger(base) || base < RECORD_START || base > buffer.length - RECORD_SIZE) {
    throw new Error(`PRC record ${index} is outside the file boundary`);
  }
  const procId = buffer.readInt32LE(base + ID_OFFSET);
  const pointCount = buffer.readInt32LE(base + POINT_COUNT_OFFSET);
  if (pointCount < MIN_POINTS || pointCount > MAX_POINTS) {
    return { index, procId, pointCount, points: null, reason: 'vertex count outside 3..16' };
  }
  const points = [];
  let outOfRange = false;
  for (let point = 0; point < pointCount; point += 1) {
    const xOffset = base + POINT_X_OFFSET + point * 4;
    const yOffset = base + POINT_Y_OFFSET + point * 4;
    if (xOffset + 4 > base + RECORD_SIZE || yOffset + 4 > base + RECORD_SIZE ||
        yOffset + 4 > buffer.length) {
      throw new Error(`PRC record ${index} polygon coordinates exceed the record boundary`);
    }
    const x = buffer.readInt32LE(xOffset);
    const y = buffer.readInt32LE(yOffset);
    if (Math.abs(x) > MAX_COORDINATE || Math.abs(y) > MAX_COORDINATE) outOfRange = true;
    points.push([x, y]);
  }
  return {
    index,
    procId,
    pointCount,
    points: outOfRange ? null : points,
    reason: outOfRange ? `coordinate exceeds ±${MAX_COORDINATE}` : null,
  };
}

// Return a bounded text page with one trigger/gather polygon per record.
function renderPage(buffer, header, page) {
  const pageCount = Math.max(1, Math.ceil(header.count / PAGE_SIZE));
  if (!Number.isInteger(page) || page < 0 || page >= pageCount) {
    throw new Error(`PRC page out of range; valid pages are 0..${pageCount - 1}`);
  }
  const first = page * PAGE_SIZE;
  const end = Math.min(header.count, first + PAGE_SIZE);
  const lines = [];
  let validPolygonCount = 0;
  let skippedPolygonCount = 0;
  for (let index = first; index < end; index += 1) {
    const record = readRecord(buffer, index);
    if (record.points) validPolygonCount += 1;
    else skippedPolygonCount += 1;
    if (index >= first && index < end) {
      if (!record.points) {
        lines.push(`record ${index}: procId=${record.procId}, vertices=${record.pointCount}; skipped (${record.reason})`);
        continue;
      }
      const coordinates = record.points.map(([x, y]) => `(${x}, ${y})`).join(' ');
      lines.push(`record ${index}: procId=${record.procId}, vertices=${record.pointCount}; ${coordinates}`);
    }
  }
  const text = lines.length ? lines.join('\n') : '(无触发区记录)';
  return {
    kind: 'text',
    text,
    info: {
      format: 'QQF PROC',
      version: header.version,
      headerSize: header.headerSize,
      recordCount: header.count,
      pagePolygonRecordCount: validPolygonCount,
      pageSkippedRecordCount: skippedPolygonCount,
      pageSize: PAGE_SIZE,
      firstRecord: first,
      lastRecord: end - 1,
      coordinateLimit: MAX_COORDINATE,
      note: '只显示记录中的触发/采集区域多边形坐标；不解析尾部未知数据，也不包含 .link 中的传送目标属性。',
    },
    page,
    pageCount,
  };
}

// Public preview entry point for package entries named with the .prc suffix.
function makeProcPreview(buffer, name, options = {}) {
  if (typeof name !== 'string' || !name.toLowerCase().endsWith('.prc')) return null;
  ensureBuffer(buffer);
  const header = readHeader(buffer);
  const page = options && options.page !== undefined ? options.page : 0;
  return renderPage(buffer, header, page);
}

module.exports = { makeProcPreview };
