'use strict';

const { PNG } = require('pngjs');

const MAX_BYTES = 64 * 1024 * 1024;
const MAX_FRAMES = 4096;
const MAX_DIMENSION = 4096;
const MAGIC = 440815953;
const V11 = 65537;
const V12 = 65538;
const V13 = 65539;
const V14 = 65540;
const V15 = 65541;
const TIERS = new Map([[0x47, 1], [0x49, 1], [0x32, 2], [0x48, 4]]);
const TIER_FOR_SCALE = new Map([[1, 0x47], [2, 0x32], [4, 0x48]]);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function fail(message) {
  throw new Error(`DIMG conversion: ${message}`);
}

function range(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset > buffer.length - length) {
    fail(`${label} is truncated or outside the file`);
  }
}

function i32(buffer, offset, label) {
  range(buffer, offset, 4, label);
  return buffer.readInt32LE(offset);
}

function positiveInteger(value, label, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function signedInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
    fail(`${label} must fit a signed 32-bit integer`);
  }
  return value;
}

function selectedScale(value, original) {
  const scale = value === undefined ? original : value;
  if (!TIER_FOR_SCALE.has(scale)) fail('scale must be 1, 2, or 4');
  return scale;
}

// This parser intentionally owns byte spans. The preview parser does not expose the
// intervening version tables, unknown frame metadata, or trailing bytes to preserve.
function parse(buffer) {
  if (!Buffer.isBuffer(buffer)) fail('source must be a Buffer');
  if (buffer.length > MAX_BYTES) fail('source exceeds 64 MiB');
  range(buffer, 0, 24, 'header');
  if (buffer.readUInt32LE(0) !== MAGIC || buffer.toString('ascii', 4, 7) !== 'DIM') {
    fail('source is not a DIMG container (IANI cannot be converted)');
  }
  const originalScale = TIERS.get(buffer[7]);
  if (!originalScale) fail('unsupported DIMG family tier');
  const version = buffer.readUInt32LE(8);
  if (version < V11 || version > V15) fail(`unsupported DIMG version ${version}`);
  const globalOffset = i32(buffer, 12, 'global offset');
  const frameCount = positiveInteger(i32(buffer, 16, 'frame count'), 'frame count', MAX_FRAMES);
  const directions = positiveInteger(i32(buffer, 20, 'direction count'), 'direction count', MAX_FRAMES);
  if (frameCount % directions !== 0) fail('frame count must divide evenly into directions');
  const headerSize = version >= V12 ? 36 : 24;
  range(buffer, 0, headerSize, 'versioned header');
  if (globalOffset < headerSize) fail('global block overlaps the header');

  let bindingCount = 0;
  if (version >= V12) {
    bindingCount = i32(buffer, 28, 'binding count');
    if (bindingCount < 0 || bindingCount > 8192) fail('unsupported binding count');
    if (i32(buffer, 32, 'auxiliary-plane flag') !== 0) {
      fail('auxiliary-plane DIMG conversion is unsupported');
    }
  }

  range(buffer, globalOffset, 24, 'global block');
  let cursor = globalOffset + 24;
  const clipCount = i32(buffer, globalOffset + 20, 'clip count');
  if (clipCount < 0 || clipCount >= 10000) fail('unsupported clip count');
  range(buffer, cursor, clipCount * 4, 'clip table');
  cursor += clipCount * 4;
  if (version >= V14) {
    const count = i32(buffer, cursor, 'version 1.4 table count');
    if (count < 0 || count >= 10000) fail('unsupported version 1.4 table count');
    cursor += 4;
    range(buffer, cursor, count * 8, 'version 1.4 table');
    cursor += count * 8;
  }
  if (version >= V13) {
    const count = i32(buffer, cursor, 'version 1.3 table count');
    if (count < 0 || count >= 10000) fail('unsupported version 1.3 table count');
    cursor += 4;
    range(buffer, cursor, count * 12, 'version 1.3 table');
    cursor += count * 12;
  }

  const prefixEnd = cursor;
  const frames = [];
  for (let index = 0; index < frameCount; index += 1) {
    const start = cursor;
    const geometryOffset = start + (version >= V11 ? 12 : 8);
    range(buffer, start, geometryOffset - start + 16, `frame ${index} geometry`);
    const width = i32(buffer, geometryOffset, `frame ${index} width`);
    const height = i32(buffer, geometryOffset + 4, `frame ${index} height`);
    const pitch = i32(buffer, geometryOffset + 8, `frame ${index} pitch`);
    const attribute = i32(buffer, geometryOffset + 12, `frame ${index} attribute`);
    const empty = width === 0 && height === 0;
    if (!empty && (width < 1 || width > MAX_DIMENSION || height < 1 || height > MAX_DIMENSION)) {
      fail(`frame ${index} has unsupported dimensions ${width}×${height}`);
    }
    if (attribute < 0 || attribute > 2) fail(`frame ${index} has unsupported pixel attribute`);
    cursor = geometryOffset + 16;
    if (!empty) {
      if (pitch < width * (attribute === 2 ? 4 : 2)) fail(`frame ${index} pitch is too short`);
      range(buffer, cursor, pitch * height, `frame ${index} pixels`);
      cursor += pitch * height;
    } else if (pitch !== 0) {
      fail(`empty frame ${index} has a nonzero pitch`);
    }
    const suffixStart = cursor;
    if (version >= V12) {
      range(buffer, cursor, 12, `frame ${index} center metadata`);
      cursor += 12;
      range(buffer, cursor, bindingCount * 8, `frame ${index} bindings`);
      cursor += bindingCount * 8;
    }
    frames.push({ index, start, end: cursor, suffixStart, geometryOffset, width, height, empty });
  }
  return { buffer, originalScale, version, frameCount, directions, bindingCount, prefixEnd, frames, trailingStart: cursor };
}

function scaledDimension(dimension, fromScale, toScale, label) {
  const result = dimension * toScale / fromScale;
  if (!Number.isSafeInteger(result)) {
    fail(`${label} cannot be represented exactly at scale ${toScale}`);
  }
  positiveInteger(result, label, MAX_DIMENSION);
  return result;
}

function describeTemplate(buffer, scale, role = 'body') {
  const source = parse(buffer);
  const targetScale = selectedScale(scale, source.originalScale);
  if (role !== 'body' && role !== 'part') fail('role must be body or part');
  if (role === 'part' && source.version < V12) {
    fail('part anchors require DIMG version 1.2 or later frame centers');
  }
  const globalOffset = i32(buffer, 12, 'global offset');
  return {
    directions: source.directions,
    framesPerDirection: source.frameCount / source.directions,
    scale: targetScale,
    logicalWidth: i32(buffer, globalOffset, 'bound width'),
    logicalHeight: i32(buffer, globalOffset + 4, 'bound height'),
    frames: source.frames.map(frame => {
      const left = i32(buffer, frame.start, `frame ${frame.index} left`);
      const top = i32(buffer, frame.start + 4, `frame ${frame.index} top`);
      // PlayerAvatar.Frames anchors bound body art at fcx/fcy only when
      // bindings exist. Attached parts always use their own frame center.
      const useFrameCenter = role === 'part' || source.bindingCount > 0;
      const logicalPivotX = useFrameCenter
        ? i32(buffer, frame.suffixStart, `frame ${frame.index} center x`)
        : i32(buffer, globalOffset + 8, 'bound center x') - left;
      const logicalPivotY = useFrameCenter
        ? i32(buffer, frame.suffixStart + 4, `frame ${frame.index} center y`)
        : i32(buffer, globalOffset + 12, 'bound center y') - top;
      return {
        index: frame.index,
        width: frame.empty ? 0 : scaledDimension(frame.width, source.originalScale, targetScale, `frame ${frame.index} width`),
        height: frame.empty ? 0 : scaledDimension(frame.height, source.originalScale, targetScale, `frame ${frame.index} height`),
        pivotX: logicalPivotX * targetScale,
        pivotY: logicalPivotY * targetScale,
        logicalPivotX,
        logicalPivotY,
        empty: frame.empty,
      };
    }),
  };
}

function decodePng(buffer, width, height, label) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 24 || buffer.length > MAX_BYTES ||
      !buffer.subarray(0, 8).equals(PNG_SIGNATURE) || buffer.toString('ascii', 12, 16) !== 'IHDR') {
    fail(`${label} must be a PNG Buffer of at most 64 MiB`);
  }
  if (buffer.readUInt32BE(16) !== width || buffer.readUInt32BE(20) !== height) {
    fail(`${label} must be exactly ${width}×${height} pixels`);
  }
  let png;
  try {
    png = PNG.sync.read(buffer, { maxChunkSize: MAX_BYTES });
  } catch (error) {
    fail(`${label} cannot be decoded as PNG: ${error.message}`);
  }
  if (png.width !== width || png.height !== height || png.data.length !== width * height * 4) {
    fail(`${label} decoded dimensions are invalid`);
  }
  return png.data;
}

// DIMG stores the same top-down row order as PNG. The official client reverses
// rows when uploading into Unity's bottom-up texture buffer.
function bgraPlane(rgba, width, height) {
  const output = Buffer.alloc(width * height * 4);
  for (let offset = 0; offset < output.length; offset += 4) {
    output[offset] = rgba[offset + 2];
    output[offset + 1] = rgba[offset + 1];
    output[offset + 2] = rgba[offset];
    output[offset + 3] = rgba[offset + 3];
  }
  return output;
}

function boundedConcat(parts, total) {
  if (total > MAX_BYTES) fail('converted DIMG exceeds 64 MiB');
  return Buffer.concat(parts, total);
}

function replaceFrames(buffer, pngBuffers, scale) {
  const source = parse(buffer);
  const targetScale = selectedScale(scale, source.originalScale);
  if (!Array.isArray(pngBuffers) || pngBuffers.length !== source.frameCount) {
    fail(`provide exactly ${source.frameCount} PNG frame entries`);
  }
  let inputBytes = 0;
  let pixelBytes = 0;
  let outputBytes = source.prefixEnd + buffer.length - source.trailingStart;
  const prefix = Buffer.from(buffer.subarray(0, source.prefixEnd));
  prefix[7] = targetScale === source.originalScale ? buffer[7] : TIER_FOR_SCALE.get(targetScale);
  const parts = [prefix];
  for (const frame of source.frames) {
    const pngBuffer = pngBuffers[frame.index];
    if (frame.empty) {
      if (pngBuffer != null) fail(`frame ${frame.index} is empty and requires a null PNG entry`);
      const unchanged = buffer.subarray(frame.start, frame.end);
      outputBytes += unchanged.length;
      parts.push(unchanged);
      continue;
    }
    const width = scaledDimension(frame.width, source.originalScale, targetScale, `frame ${frame.index} width`);
    const height = scaledDimension(frame.height, source.originalScale, targetScale, `frame ${frame.index} height`);
    if (!Buffer.isBuffer(pngBuffer)) fail(`frame ${frame.index} requires a PNG Buffer`);
    inputBytes += pngBuffer.length;
    pixelBytes += width * height * 4;
    if (inputBytes > MAX_BYTES || pixelBytes > MAX_BYTES) fail('PNG input or decoded pixels exceed 64 MiB');
    const rgba = decodePng(pngBuffer, width, height, `frame ${frame.index}`);
    const geometry = Buffer.from(buffer.subarray(frame.start, frame.geometryOffset + 16));
    geometry.writeInt32LE(width, frame.geometryOffset - frame.start);
    geometry.writeInt32LE(height, frame.geometryOffset - frame.start + 4);
    geometry.writeInt32LE(width * 4, frame.geometryOffset - frame.start + 8);
    geometry.writeInt32LE(2, frame.geometryOffset - frame.start + 12);
    const plane = bgraPlane(rgba, width, height);
    const suffix = buffer.subarray(frame.suffixStart, frame.end);
    outputBytes += geometry.length + plane.length + suffix.length;
    if (outputBytes > MAX_BYTES) fail('converted DIMG exceeds 64 MiB');
    parts.push(geometry, plane, suffix);
  }
  parts.push(buffer.subarray(source.trailingStart));
  return boundedConcat(parts, outputBytes);
}

function createSprite(pngBuffers, options) {
  if (!options || typeof options !== 'object') fail('sprite options are required');
  const width = positiveInteger(options.width, 'logical width', MAX_DIMENSION);
  const height = positiveInteger(options.height, 'logical height', MAX_DIMENSION);
  const scale = selectedScale(options.scale, 1);
  const directions = positiveInteger(options.directions, 'direction count', MAX_FRAMES);
  const framesPerDirection = positiveInteger(options.framesPerDirection, 'frames per direction', MAX_FRAMES);
  const count = directions * framesPerDirection;
  if (count > MAX_FRAMES || !Array.isArray(pngBuffers) || pngBuffers.length !== count) {
    fail(`provide exactly ${count} PNG frames within the ${MAX_FRAMES}-frame limit`);
  }
  const pivotX = signedInteger(options.pivotX === undefined ? Math.floor(width / 2) : options.pivotX, 'pivotX');
  const pivotY = signedInteger(options.pivotY === undefined ? height : options.pivotY, 'pivotY');
  const physicalWidth = positiveInteger(width * scale, 'physical width', MAX_DIMENSION);
  const physicalHeight = positiveInteger(height * scale, 'physical height', MAX_DIMENSION);
  const header = Buffer.alloc(60);
  header.writeUInt32LE(MAGIC, 0);
  header.write('DIM', 4, 'ascii');
  header[7] = TIER_FOR_SCALE.get(scale);
  header.writeUInt32LE(V12, 8);
  header.writeInt32LE(36, 12);
  header.writeInt32LE(count, 16);
  header.writeInt32LE(directions, 20);
  header.writeInt32LE(width, 36);
  header.writeInt32LE(height, 40);
  header.writeInt32LE(pivotX, 44);
  header.writeInt32LE(pivotY, 48);
  const parts = [header];
  let inputBytes = 0;
  let outputBytes = header.length;
  const pixelBytes = physicalWidth * physicalHeight * 4 * count;
  if (pixelBytes > MAX_BYTES) fail('sprite pixels exceed 64 MiB');
  for (let index = 0; index < count; index += 1) {
    const pngBuffer = pngBuffers[index];
    if (!Buffer.isBuffer(pngBuffer)) fail(`frame ${index} requires a PNG Buffer`);
    inputBytes += pngBuffer.length;
    if (inputBytes > MAX_BYTES) fail('PNG input exceeds 64 MiB');
    const rgba = decodePng(pngBuffer, physicalWidth, physicalHeight, `frame ${index}`);
    const record = Buffer.alloc(40);
    record.writeInt32LE(physicalWidth, 12);
    record.writeInt32LE(physicalHeight, 16);
    record.writeInt32LE(physicalWidth * 4, 20);
    record.writeInt32LE(2, 24);
    record.writeInt32LE(pivotX, 28);
    record.writeInt32LE(pivotY, 32);
    const plane = bgraPlane(rgba, physicalWidth, physicalHeight);
    outputBytes += record.length + plane.length;
    if (outputBytes > MAX_BYTES) fail('sprite DIMG exceeds 64 MiB');
    parts.push(record.subarray(0, 28), plane, record.subarray(28));
  }
  return boundedConcat(parts, outputBytes);
}

module.exports = { describeTemplate, replaceFrames, createSprite };
