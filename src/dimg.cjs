'use strict';

const { PNG } = require('pngjs');

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_FRAME_DIMENSION = 4096;
const MAX_CANVAS_DIMENSION = 8192;
const MAX_CANVAS_PIXELS = 16 * 1024 * 1024;
const MAX_DIMG_FRAMES = 4096;
const MAX_IANI_FRAMES = 64;
const COPYRIGHT = 440815953;
const V11 = 65537;
const V12 = 65538;
const V13 = 65539;
const V14 = 65540;
const FAMILY_TIER = new Map([[0x32, 2], [0x47, 1], [0x48, 4], [0x49, 1]]);
const parsedBuffers = new WeakMap();

function isDimgCandidate(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 8 || buffer.readUInt32LE(0) !== COPYRIGHT) return false;
  const family = buffer.toString('ascii', 4, 7);
  return family === 'DIM' || family === 'IAN';
}

function checkedRange(buffer, offset, length, label) {
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) ||
      offset < 0 || length < 0 || offset > buffer.length - length) {
    throw new Error(`DIMG ${label} is truncated or outside the file`);
  }
}

function readI32(buffer, offset, label) {
  checkedRange(buffer, offset, 4, label);
  return buffer.readInt32LE(offset);
}

function readU32(buffer, offset, label) {
  checkedRange(buffer, offset, 4, label);
  return buffer.readUInt32LE(offset);
}

function checkedEnd(offset, length, label) {
  const end = offset + length;
  if (!Number.isSafeInteger(end) || end < offset) throw new Error(`DIMG ${label} has an invalid length`);
  return end;
}

function decodeFamily(buffer) {
  const family = buffer.toString('ascii', 4, 7);
  const tier = buffer[7];
  if (!FAMILY_TIER.has(tier)) throw new Error(`unsupported ${family} family tier 0x${tier.toString(16).padStart(2, '0')}`);
  if (family !== 'DIM' && family !== 'IAN') throw new Error(`unsupported DIMG family ${family}`);
  return { family: family === 'DIM' ? 'DIMG' : 'IANI', scale: FAMILY_TIER.get(tier), tier: String.fromCharCode(tier) };
}

function parseDimg(buffer, family) {
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('DIMG exceeds the 64 MiB preview limit');
  checkedRange(buffer, 0, 24, 'header');
  const version = readU32(buffer, 8, 'version');
  const globalOffset = readI32(buffer, 12, 'global offset');
  const totalFrames = readI32(buffer, 16, 'total frame count');
  const declaredDirections = readI32(buffer, 20, 'direction count');
  const directions = Math.max(declaredDirections, 1);
  if (totalFrames < 1 || totalFrames > MAX_DIMG_FRAMES) {
    throw new Error(`DIMG total frame count ${totalFrames} is outside the supported range 1–${MAX_DIMG_FRAMES}`);
  }
  if (directions > MAX_DIMG_FRAMES) throw new Error(`DIMG direction count ${directions} exceeds ${MAX_DIMG_FRAMES}`);
  if (totalFrames % directions !== 0) {
    throw new Error(`DIMG declares ${totalFrames} total frames across ${directions} directions; the frames cannot be divided evenly`);
  }
  const framesPerDirection = totalFrames / directions;

  let bindingCount = 0;
  let hasAuxiliaryPlane = false;
  if (version >= V12) {
    checkedRange(buffer, 24, 12, 'version 1.2 header');
    bindingCount = readI32(buffer, 28, 'binding count');
    const auxiliaryFlag = readI32(buffer, 32, 'auxiliary-plane flag');
    if (bindingCount < 0 || bindingCount > 8192) throw new Error(`DIMG binding count ${bindingCount} is invalid`);
    hasAuxiliaryPlane = auxiliaryFlag !== 0;
  }

  checkedRange(buffer, globalOffset, 24, 'global block');
  let cursor = globalOffset;
  const boundWidth = readI32(buffer, cursor, 'global bound width'); cursor += 4;
  const boundHeight = readI32(buffer, cursor, 'global bound height'); cursor += 4;
  const boundCx = readI32(buffer, cursor, 'global bound center x'); cursor += 4;
  const boundCy = readI32(buffer, cursor, 'global bound center y'); cursor += 4;
  const clipWidth = readI32(buffer, cursor, 'global clip width'); cursor += 4;
  const clipCount = readI32(buffer, cursor, 'global clip count'); cursor += 4;

  let clips = [];
  if (clipCount > 0 && clipCount < 10000) {
    const clipBytes = clipCount * 4;
    checkedRange(buffer, cursor, clipBytes, 'global clip array');
    for (let i = 0; i < clipCount; i += 1) clips.push(readI32(buffer, cursor + i * 4, 'global clip entry'));
    cursor += clipBytes;
  }

  // These counted global tables are skipped by DecodeAnim in the same version order.
  if (version >= V14 && cursor + 4 <= buffer.length) {
    const count = readI32(buffer, cursor, 'version 1.4 table count'); cursor += 4;
    if (count > 0 && count < 10000) {
      const bytes = count * 8;
      checkedRange(buffer, cursor, bytes, 'version 1.4 table');
      cursor += bytes;
    }
  }
  if (version >= V13 && cursor + 4 <= buffer.length) {
    const count = readI32(buffer, cursor, 'version 1.3 table count'); cursor += 4;
    if (count > 0 && count < 10000) {
      const bytes = count * 12;
      checkedRange(buffer, cursor, bytes, 'version 1.3 table');
      cursor += bytes;
    }
  }

  const frames = [];
  for (let frameIndex = 0; frameIndex < totalFrames; frameIndex += 1) {
    checkedRange(buffer, cursor, 8, `frame ${frameIndex} position`);
    const left = readI32(buffer, cursor, `frame ${frameIndex} left`); cursor += 4;
    const top = readI32(buffer, cursor, `frame ${frameIndex} top`); cursor += 4;
    let flags = 0;
    if (version >= V11) {
      flags = readI32(buffer, cursor, `frame ${frameIndex} flags`); cursor += 4;
    }
    checkedRange(buffer, cursor, 16, `frame ${frameIndex} geometry`);
    const width = readI32(buffer, cursor, `frame ${frameIndex} width`); cursor += 4;
    const height = readI32(buffer, cursor, `frame ${frameIndex} height`); cursor += 4;
    const pitch = readI32(buffer, cursor, `frame ${frameIndex} pitch`); cursor += 4;
    const attribute = readI32(buffer, cursor, `frame ${frameIndex} attribute`); cursor += 4;

    const empty = width === 0 && height === 0;
    if (!(empty || (width > 0 && height > 0 && width <= MAX_FRAME_DIMENSION && height <= MAX_FRAME_DIMENSION))) {
      throw new Error(`DIMG frame ${frameIndex} has unsupported dimensions ${width}×${height}`);
    }
    if (![0, 1, 2].includes(attribute)) throw new Error(`DIMG frame ${frameIndex} uses unsupported pixel attribute ${attribute}`);
    let pixelOffset = cursor;
    let pixelLength = 0;
    if (!empty) {
      const bytesPerPixel = attribute === 2 ? 4 : 2;
      if (!Number.isSafeInteger(pitch) || pitch < width * bytesPerPixel) {
        throw new Error(`DIMG frame ${frameIndex} pitch ${pitch} is too short for ${width} pixels`);
      }
      pixelLength = pitch * height;
      checkedRange(buffer, cursor, pixelLength, `frame ${frameIndex} pixel plane`);
      cursor += pixelLength;
    }

    let fcx = 0;
    let fcy = 0;
    if (version > V11) {
      checkedRange(buffer, cursor, 12, `frame ${frameIndex} center metadata`);
      fcx = readI32(buffer, cursor, `frame ${frameIndex} center x`);
      fcy = readI32(buffer, cursor + 4, `frame ${frameIndex} center y`);
      cursor += 12;
    }

    const bindings = [];
    if (version >= V12 && bindingCount > 0) {
      const bytes = bindingCount * 8;
      checkedRange(buffer, cursor, bytes, `frame ${frameIndex} bindings`);
      for (let binding = 0; binding < bindingCount; binding += 1) {
        bindings.push({
          x: readI32(buffer, cursor + binding * 8, `frame ${frameIndex} binding x`),
          y: readI32(buffer, cursor + binding * 8 + 4, `frame ${frameIndex} binding y`),
        });
      }
      cursor += bytes;
    }

    if (hasAuxiliaryPlane) {
      checkedRange(buffer, cursor, 24, `frame ${frameIndex} auxiliary-plane header`);
      const auxiliaryWidth = readI32(buffer, cursor + 8, `frame ${frameIndex} auxiliary width`);
      const auxiliaryHeight = readI32(buffer, cursor + 12, `frame ${frameIndex} auxiliary height`);
      const auxiliaryPitch = readI32(buffer, cursor + 16, `frame ${frameIndex} auxiliary pitch`);
      cursor += 24;
      if (auxiliaryWidth > 0 && auxiliaryHeight > 0) {
        if (auxiliaryPitch < 0) throw new Error(`DIMG frame ${frameIndex} auxiliary pitch is negative`);
        const auxiliaryLength = auxiliaryPitch * auxiliaryHeight;
        checkedRange(buffer, cursor, auxiliaryLength, `frame ${frameIndex} auxiliary plane`);
        cursor += auxiliaryLength;
      }
    }

    frames.push({ frameIndex, left, top, flags, width, height, pitch, attribute, pixelOffset, pixelLength, fcx, fcy, bindings, empty });
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const frame of frames) {
    if (frame.empty) continue;
    minX = Math.min(minX, frame.left);
    minY = Math.min(minY, frame.top);
    maxX = Math.max(maxX, frame.left + frame.width);
    maxY = Math.max(maxY, frame.top + frame.height);
  }
  if (!Number.isFinite(minX)) {
    // A clip-only/fully empty animation still has a stable transparent preview canvas.
    minX = 0;
    minY = 0;
    maxX = 1;
    maxY = 1;
  }
  const canvasWidth = maxX - minX;
  const canvasHeight = maxY - minY;
  if (!Number.isSafeInteger(canvasWidth) || !Number.isSafeInteger(canvasHeight) ||
      canvasWidth < 1 || canvasHeight < 1 || canvasWidth > MAX_CANVAS_DIMENSION ||
      canvasHeight > MAX_CANVAS_DIMENSION || canvasWidth * canvasHeight > MAX_CANVAS_PIXELS) {
    throw new Error(`DIMG stable frame canvas ${canvasWidth}×${canvasHeight} exceeds preview limits`);
  }

  return {
    family: family.family,
    tier: family.tier,
    scale: family.scale,
    version,
    totalFrames,
    framesPerDirection,
    directions,
    frames,
    canvas: { width: canvasWidth, height: canvasHeight, originX: minX, originY: minY },
    global: { boundWidth, boundHeight, boundCx, boundCy, clipWidth, clips },
  };
}

function parseIani(buffer, family) {
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('IANI exceeds the 64 MiB preview limit');
  checkedRange(buffer, 0, 16, 'IANI header');
  const globalOffset = readI32(buffer, 12, 'IANI data offset');
  if (!Number.isSafeInteger(globalOffset) || globalOffset < 16 || globalOffset > buffer.length) {
    throw new Error(`IANI data offset ${globalOffset} is invalid`);
  }

  let cursor = globalOffset;
  const frames = [];
  while (cursor + 16 <= buffer.length && frames.length < MAX_IANI_FRAMES) {
    const width = readI32(buffer, cursor, 'IANI frame width'); cursor += 4;
    const height = readI32(buffer, cursor, 'IANI frame height'); cursor += 4;
    const pitch = readI32(buffer, cursor, 'IANI frame pitch'); cursor += 4;
    const attribute = readI32(buffer, cursor, 'IANI frame attribute'); cursor += 4;
    if (width < 1 || width > MAX_FRAME_DIMENSION || height < 1 || height > MAX_FRAME_DIMENSION ||
        ![0, 1, 2].includes(attribute)) {
      if (frames.length === 0) throw new Error('IANI begins with an unsupported frame record');
      break;
    }
    const bytesPerPixel = attribute === 2 ? 4 : 2;
    if (pitch < width * bytesPerPixel) {
      if (frames.length === 0) throw new Error(`IANI frame pitch ${pitch} is too short for ${width} pixels`);
      break;
    }
    const pixelLength = pitch * height;
    if (!Number.isSafeInteger(pixelLength) || cursor + pixelLength > buffer.length) {
      if (frames.length === 0) throw new Error('IANI first frame pixel plane is truncated');
      break;
    }
    frames.push({ frameIndex: frames.length, left: 0, top: 0, width, height, pitch, attribute, pixelOffset: cursor, pixelLength, empty: false });
    cursor += pixelLength;
  }
  if (frames.length === 0) throw new Error('IANI contains no supported frames');
  const canvasWidth = Math.max(...frames.map(frame => frame.width));
  const canvasHeight = Math.max(...frames.map(frame => frame.height));
  if (canvasWidth > MAX_CANVAS_DIMENSION || canvasHeight > MAX_CANVAS_DIMENSION || canvasWidth * canvasHeight > MAX_CANVAS_PIXELS) {
    throw new Error(`IANI stable frame canvas ${canvasWidth}×${canvasHeight} exceeds preview limits`);
  }
  return {
    family: 'IANI', tier: family.tier, scale: family.scale, version: readU32(buffer, 8, 'IANI version'),
    totalFrames: frames.length, framesPerDirection: frames.length, directions: 1, frames,
    canvas: { width: canvasWidth, height: canvasHeight, originX: 0, originY: 0 },
    global: {},
  };
}

function parseAnimation(buffer) {
  const cached = parsedBuffers.get(buffer);
  if (cached) return cached;
  if (!isDimgCandidate(buffer)) throw new Error('not a DIMG/IANI container');
  const family = decodeFamily(buffer);
  const parsed = family.family === 'DIMG' ? parseDimg(buffer, family) : parseIani(buffer, family);
  parsedBuffers.set(buffer, parsed);
  return parsed;
}

// Read-only geometry view for consumers that place rendered animation frames.
// Keep this projection separate from decoding so existing preview behavior is unchanged.
function inspectAnimation(buffer) {
  const metadata = parseAnimation(buffer);
  return {
    family: metadata.family,
    tier: metadata.scale,
    totalFrames: metadata.frames.length,
    framesPerDirection: metadata.framesPerDirection,
    directions: metadata.directions,
    canvas: {
      width: metadata.canvas.width,
      height: metadata.canvas.height,
      originX: metadata.canvas.originX,
      originY: metadata.canvas.originY,
    },
    global: {
      boundCx: metadata.global.boundCx ?? null,
      boundCy: metadata.global.boundCy ?? null,
    },
    frames: metadata.frames.map(frame => ({
      frameIndex: frame.frameIndex,
      left: frame.left,
      top: frame.top,
      width: frame.width,
      height: frame.height,
      empty: frame.empty,
    })),
  };
}

function expandFive(value) {
  return (value * 2156535) >> 18;
}

function expandNibble(value) {
  return (value | (value << 4)) & 0xff;
}

function decodeSelectedFrame(buffer, metadata, selectedIndex) {
  const frame = metadata.frames[selectedIndex];
  if (!frame) throw new Error(`DIMG frame index ${selectedIndex} is outside the available ${metadata.frames.length} frames`);
  const { width: canvasWidth, height: canvasHeight, originX, originY } = metadata.canvas;
  const rgba = Buffer.alloc(canvasWidth * canvasHeight * 4);
  if (frame.empty) return { rgba, frame };

  const xOffset = frame.left - originX;
  const yOffset = frame.top - originY;
  for (let y = 0; y < frame.height; y += 1) {
    let source = frame.pixelOffset + y * frame.pitch;
    let destination = ((yOffset + y) * canvasWidth + xOffset) * 4;
    for (let x = 0; x < frame.width; x += 1) {
      if (frame.attribute === 2) {
        rgba[destination] = buffer[source + 2];
        rgba[destination + 1] = buffer[source + 1];
        rgba[destination + 2] = buffer[source];
        rgba[destination + 3] = buffer[source + 3];
        source += 4;
      } else {
        const low = buffer[source];
        const high = buffer[source + 1];
        if (frame.attribute === 1) {
          rgba[destination] = expandNibble(high & 15);
          rgba[destination + 1] = expandNibble(low >> 4);
          rgba[destination + 2] = expandNibble(low & 15);
          rgba[destination + 3] = expandNibble(high >> 4);
        } else {
          const packed = low | (high << 8);
          rgba[destination] = expandFive((packed >> 10) & 31);
          rgba[destination + 1] = expandFive((packed >> 5) & 31);
          rgba[destination + 2] = expandFive(packed & 31);
          rgba[destination + 3] = (high >> 7) * 255;
        }
        source += 2;
      }
      destination += 4;
    }
  }
  return { rgba, frame };
}

function renderFrame(buffer, options = {}) {
  const metadata = parseAnimation(buffer);
  const frameIndex = options.frameIndex === undefined ? 0 : options.frameIndex;
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= metadata.frames.length) {
    throw new Error(`frameIndex must be an integer from 0 to ${metadata.frames.length - 1}`);
  }
  const decoded = decodeSelectedFrame(buffer, metadata, frameIndex);
  const png = PNG.sync.write({ width: metadata.canvas.width, height: metadata.canvas.height, data: decoded.rgba });
  const direction = Math.floor(frameIndex / metadata.framesPerDirection);
  const frameInDirection = frameIndex % metadata.framesPerDirection;
  return {
    kind: 'animation',
    mime: 'image/png',
    base64: png.toString('base64'),
    width: metadata.canvas.width,
    height: metadata.canvas.height,
    framesPerDirection: metadata.framesPerDirection,
    directions: metadata.directions,
    frameIndex,
    info: `${metadata.family} tier ${metadata.tier} · v${metadata.version} · direction ${direction + 1}/${metadata.directions}, frame ${frameInDirection + 1}/${metadata.framesPerDirection}${decoded.frame.empty ? ' · empty frame' : ''} · stable canvas ${metadata.canvas.width}×${metadata.canvas.height}`,
  };
}

// Scene placement needs the same validated geometry as the standalone preview.
// Keeping it here avoids a second, narrower DIMG header parser in the map viewer.
function renderStaticFrame(buffer) {
  const metadata = parseAnimation(buffer);
  if (metadata.family !== 'DIMG' || metadata.frames.length !== 1) {
    throw new Error('场景物件目前只合成单帧 DIMG，动画物件可单独打开预览');
  }
  if (metadata.frames[0].empty) throw new Error('场景物件首帧为空');
  return {
    ...renderFrame(buffer, { frameIndex: 0 }),
    origin: {
      left: metadata.canvas.originX,
      top: metadata.canvas.originY,
      tier: metadata.scale,
      clips: metadata.global.clips.length,
    },
  };
}

module.exports = { isDimgCandidate, renderFrame, renderStaticFrame, inspectAnimation };
