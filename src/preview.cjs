'use strict';

const { PNG } = require('pngjs');
const { isDimgCandidate, renderFrame: renderDimgFrame } = require('./dimg.cjs');

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_DIMENSION = 8192;
const MAX_PIXELS = 16 * 1024 * 1024;
const MAX_TEXT_CHARS = 1024 * 1024;
const HEX_BYTES = 512;
const MAX_GSA_FRAME_RECORDS = 262144;
const GSA_MAGIC = Buffer.from([0x51, 0x51, 0x46, 0x1a, 0x49, 0x41, 0x4e]);
const GSA_HEADER_LENGTH = 36;
const GSA_RECORD_HEADER_LENGTH = 16;

function ensureBuffer(value) {
  if (!Buffer.isBuffer(value)) throw new TypeError('buffer must be a Buffer');
  if (value.length > MAX_INPUT_BYTES) throw new Error('file exceeds the 64 MiB preview limit');
}

function validDimensions(width, height) {
  return Number.isSafeInteger(width) && Number.isSafeInteger(height) &&
    width > 0 && height > 0 && width <= MAX_DIMENSION && height <= MAX_DIMENSION &&
    width * height <= MAX_PIXELS;
}

function gsaHeader(buffer) {
  if (buffer.length < GSA_HEADER_LENGTH || !buffer.subarray(0, 7).equals(GSA_MAGIC)) return null;
  const version = buffer[7];
  if (![0x32, 0x47, 0x48, 0x49].includes(version)) return null;
  const dataOffset = buffer.readInt32LE(12);
  const tileWidth = buffer.readInt32LE(16);
  const tileHeight = buffer.readInt32LE(20);
  const width = buffer.readInt32LE(24);
  const height = buffer.readInt32LE(28);
  const frames = buffer.readInt32LE(32);
  if (!validDimensions(width, height) || tileWidth < 1 || tileHeight < 1 ||
      dataOffset < GSA_HEADER_LENGTH || dataOffset > buffer.length - GSA_RECORD_HEADER_LENGTH) return null;
  return { version: String.fromCharCode(version), dataOffset, tileWidth, tileHeight, width, height, frames };
}

function readGsaRecord(buffer, offset) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > buffer.length - GSA_RECORD_HEADER_LENGTH) return null;
  const width = buffer.readInt32LE(offset);
  const height = buffer.readInt32LE(offset + 4);
  const pitch = buffer.readInt32LE(offset + 8);
  const attribute = buffer.readInt32LE(offset + 12);
  if (!validDimensions(width, height) || width > 4096 || height > 4096 || pitch <= 0) return null;
  const bytesPerPixel = attribute === 2 ? 4 : 2;
  // The official reader advances by pitch * height and addresses pixels by row * pitch.
  // Require enough bytes for every accessed pixel, even where the native header gate is looser.
  if (![0, 1, 2].includes(attribute) || pitch < width * bytesPerPixel) return null;
  const payloadOffset = offset + GSA_RECORD_HEADER_LENGTH;
  const payloadLength = pitch * height;
  const endOffset = payloadOffset + payloadLength;
  if (!Number.isSafeInteger(endOffset) || endOffset > buffer.length) return null;
  return { offset, width, height, pitch, attribute, payloadOffset, payloadLength, endOffset };
}

function writeGsaPixel(buffer, record, source, rgba, destination) {
  if (record.attribute === 0) {
    const low = buffer[source];
    const high = buffer[source + 1];
    rgba[destination] = ((high >> 2) & 31) << 3;
    rgba[destination + 1] = (((low >> 5) | ((high & 3) << 3)) & 31) << 3;
    rgba[destination + 2] = (low & 31) << 3;
    rgba[destination + 3] = (high & 0x80) === 0 ? 0 : 255;
    return;
  }
  if (record.attribute === 1) {
    const low = buffer[source];
    const high = buffer[source + 1];
    rgba[destination] = ((high & 15) << 4) | (high & 15);
    rgba[destination + 1] = (((low >> 4) & 15) << 4) | ((low >> 4) & 15);
    rgba[destination + 2] = ((low & 15) << 4) | (low & 15);
    rgba[destination + 3] = ((high >> 4) << 4) | (high >> 4);
    return;
  }
  if (record.attribute === 2) {
    rgba[destination] = buffer[source + 2];
    rgba[destination + 1] = buffer[source + 1];
    rgba[destination + 2] = buffer[source];
    rgba[destination + 3] = buffer[source + 3];
    return;
  }
  throw new Error(`unsupported GSA attribute ${record.attribute}`);
}

function decodeGsaFrameZero(buffer, header) {
  const record = readGsaRecord(buffer, header.dataOffset);
  if (!record) throw new Error('GSA 首个图块/记录（非完整动画或拼接图）格式不受支持或已损坏');
  if (!validDimensions(record.width, record.height)) throw new Error('GSA 首个图块/记录（非完整动画或拼接图）超出预览尺寸限制');
  const rgba = Buffer.alloc(record.width * record.height * 4);
  for (let sourceY = 0; sourceY < record.height; sourceY += 1) {
    let source = record.payloadOffset + sourceY * record.pitch;
    // PNG rows are top-down, matching the source record row order.
    let destination = sourceY * record.width * 4;
    for (let x = 0; x < record.width; x += 1) {
      writeGsaPixel(buffer, record, source, rgba, destination);
      source += record.attribute === 2 ? 4 : 2;
      destination += 4;
    }
  }
  return { record, rgba };
}

function decodeGsaAssembledCanvasFrame(buffer, header, frameIndex = 0) {
  const tilesAcross = Math.max(1, Math.ceil(header.width / header.tileWidth));
  const tilesDown = Math.max(1, Math.ceil(header.height / header.tileHeight));
  const recordsPerFrame = tilesAcross * tilesDown;
  if (!Number.isSafeInteger(recordsPerFrame) || recordsPerFrame < 1 || recordsPerFrame > MAX_GSA_FRAME_RECORDS) {
    throw new Error(`GSA first assembled canvas needs too many tile records (${recordsPerFrame})`);
  }
  if (!Number.isSafeInteger(header.frames) || header.frames < 1 || header.frames > 4096) {
    throw new Error(`GSA declared frame count is outside the supported range: ${header.frames}`);
  }
  if (!Number.isSafeInteger(frameIndex) || frameIndex < 0 || frameIndex >= header.frames) {
    throw new Error(`GSA frame index ${frameIndex} is outside 0..${header.frames - 1}`);
  }
  const firstRecord = frameIndex * recordsPerFrame;
  const lastRecordExclusive = firstRecord + recordsPerFrame;
  const declaredRecordCount = header.frames * recordsPerFrame;
  if (!Number.isSafeInteger(lastRecordExclusive) || !Number.isSafeInteger(declaredRecordCount) ||
      declaredRecordCount > MAX_GSA_FRAME_RECORDS) {
    throw new Error(`GSA declared animation exceeds the ${MAX_GSA_FRAME_RECORDS} record processing limit`);
  }

  const rgba = Buffer.alloc(header.width * header.height * 4);
  let recordOffset = header.dataOffset;
  for (let recordIndex = 0; recordIndex < declaredRecordCount; recordIndex += 1) {
    const record = readGsaRecord(buffer, recordOffset);
    if (!record) {
      const frameRecord = recordIndex % recordsPerFrame;
      const frameNumber = Math.floor(recordIndex / recordsPerFrame) + 1;
      throw new Error(`GSA declared frame ${frameNumber} is incomplete or malformed at tile record ${frameRecord + 1}/${recordsPerFrame}`);
    }

    if (recordIndex >= firstRecord && recordIndex < lastRecordExclusive) {
      if (![0, 1, 2].includes(record.attribute)) {
        throw new Error(`GSA frame ${frameIndex + 1}, tile record ${recordIndex - firstRecord + 1} uses unsupported attribute ${record.attribute}`);
      }
      // DecodeFrameAssembled assigns records row-major and clips only at the canvas
      // bounds; oversized records can spill into the next tile cell.
      const frameRecord = recordIndex - firstRecord;
      const tileX = frameRecord % tilesAcross;
      const tileY = Math.floor(frameRecord / tilesAcross);
      const destinationX = tileX * header.tileWidth;
      const destinationY = tileY * header.tileHeight;
      for (let sourceY = 0; sourceY < record.height; sourceY += 1) {
        const y = destinationY + sourceY;
        if (y >= header.height) break;
        let source = record.payloadOffset + sourceY * record.pitch;
        for (let sourceX = 0; sourceX < record.width; sourceX += 1) {
          const x = destinationX + sourceX;
          if (x >= header.width) break;
          const destination = (y * header.width + x) * 4;
          writeGsaPixel(buffer, record, source, rgba, destination);
          source += record.attribute === 2 ? 4 : 2;
        }
      }
    }
    recordOffset = record.endOffset;
  }

  return { rgba, tilesAcross, tilesDown, recordsPerFrame, frameIndex };
}

function pngBuffer(width, height, data) {
  if (!validDimensions(width, height) || data.length !== width * height * 4) {
    throw new Error('image dimensions exceed preview limits');
  }
  return PNG.sync.write({ width, height, data });
}

function pngDimensions(buffer) {
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return null;
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 4 <= buffer.length) {
    if (buffer[offset] !== 0xff) { offset += 1; continue; }
    while (buffer[offset] === 0xff) offset += 1;
    const marker = buffer[offset++];
    if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > buffer.length) return null;
    const length = buffer.readUInt16BE(offset);
    if (length < 2 || offset + length > buffer.length) return null;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      if (length < 7) return null;
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function browserImage(buffer, name) {
  const png = pngDimensions(buffer);
  if (png) return { mime: 'image/png', ...png, format: 'PNG' };
  const jpeg = jpegDimensions(buffer);
  if (jpeg) return { mime: 'image/jpeg', ...jpeg, format: 'JPEG' };
  if (buffer.length >= 10 && (buffer.toString('ascii', 0, 6) === 'GIF87a' || buffer.toString('ascii', 0, 6) === 'GIF89a')) {
    return { mime: 'image/gif', width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8), format: 'GIF' };
  }
  if (buffer.length >= 26 && buffer.toString('ascii', 0, 2) === 'BM') {
    const width = buffer.readInt32LE(18);
    const rawHeight = buffer.readInt32LE(22);
    return { mime: 'image/bmp', width, height: Math.abs(rawHeight), format: 'BMP' };
  }
  if (buffer.length >= 30 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP') {
    const kind = buffer.toString('ascii', 12, 16);
    if (kind === 'VP8X') return { mime: 'image/webp', width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3), format: 'WebP' };
    if (kind === 'VP8 ' && buffer.length >= 30) return { mime: 'image/webp', width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff, format: 'WebP' };
    if (kind === 'VP8L' && buffer.length >= 25) {
      const bits = buffer.readUInt32LE(21);
      return { mime: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1, format: 'WebP' };
    }
  }
  const extension = String(name || '').toLowerCase().split('.').pop();
  if (extension === 'jpg' || extension === 'jpeg') return null;
  return null;
}

function audioMime(buffer) {
  if (buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WAVE') return 'audio/wav';
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'OggS') return 'audio/ogg';
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'fLaC') return 'audio/flac';
  if (buffer.length >= 3 && buffer.toString('ascii', 0, 3) === 'ID3') return 'audio/mpeg';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'audio/mpeg';
  if (buffer.length >= 4 && buffer.toString('ascii', 0, 4) === 'MThd') return 'audio/midi';
  return null;
}

function isTextExtension(name) {
  return /\.(txt|md|json|xml|html?|css|js|cjs|mjs|ts|csv|log|ini|yaml|yml|toml|cfg|lua|shader|vert|frag|cs|sql|def|link|npc|lst)$/i.test(String(name || ''));
}

function readableText(text) {
  let printable = 0;
  let count = 0;
  for (const char of text) {
    const code = char.codePointAt(0);
    count += 1;
    if (code === 9 || code === 10 || code === 13 ||
        (code >= 32 && !(code >= 127 && code <= 159) && code !== 0xfffd)) printable += 1;
  }
  return !count || printable >= count * 0.98;
}

function decodeText(buffer, name) {
  if (!buffer.length) return isTextExtension(name) ? { text: '', encoding: 'UTF-8' } : null;
  // Only a BOM identifies UTF-16; zero bytes in binary resources must not be guessed as text.
  if (buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe) || (buffer[0] === 0xfe && buffer[1] === 0xff))) {
    if (buffer.length % 2) return null;
    const encoding = buffer[0] === 0xff ? 'UTF-16LE' : 'UTF-16BE';
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(buffer);
      return readableText(text) ? { text, encoding } : null;
    } catch (_) { return null; }
  }
  if (buffer.includes(0)) return null;
  // MapLink.Legacy.cs reads map/*.link with Gbk.GetString. Map NPC/spawn lists
  // use the same legacy text family; only accept a valid, printable GBK stream.
  const gbkEligible = /\.(def|ini|txt|cfg|link|npc|lst)$/i.test(String(name || ''));
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    if (!readableText(text)) return null;
    return { text, encoding: 'UTF-8' };
  } catch (_) {
    if (!gbkEligible) return null;
    try {
      const text = new TextDecoder('gbk', { fatal: true }).decode(buffer);
      return readableText(text) ? { text, encoding: 'GBK' } : null;
    } catch (_) {
      return null;
    }
  }
}

function hexView(buffer, reason) {
  const shown = buffer.subarray(0, HEX_BYTES);
  const lines = [];
  for (let row = 0; row < shown.length; row += 16) {
    const part = shown.subarray(row, row + 16);
    const hex = Array.from(part, byte => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = Array.from(part, byte => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
    lines.push(`${row.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }
  if (buffer.length > shown.length) lines.push(`… ${buffer.length - shown.length} more bytes`);
  return { kind: 'hex', text: lines.join('\n'), info: reason || `${buffer.length} bytes` };
}

async function makePreview(buffer, name, options = {}) {
  ensureBuffer(buffer);
  const header = gsaHeader(buffer);
  if (header) {
    const hasFrameIndex = Object.prototype.hasOwnProperty.call(options, 'frameIndex');
    const frameIndex = hasFrameIndex ? options.frameIndex : 0;
    let decoded;
    try {
      decoded = decodeGsaAssembledCanvasFrame(buffer, header, frameIndex);
    } catch (error) {
      return hexView(buffer, error.message);
    }
    const png = pngBuffer(header.width, header.height, decoded.rgba);
    if (hasFrameIndex || header.frames > 1) {
      return {
        kind: 'animation', mime: 'image/png', base64: png.toString('base64'),
        width: header.width, height: header.height,
        framesPerDirection: header.frames, directions: 1, frameIndex,
        info: `GSA 拼接帧 ${frameIndex + 1}/${header.frames} · ${decoded.tilesAcross}×${decoded.tilesDown} tile records · 单方向帧序列`,
      };
    }
    return {
      kind: 'image', mime: 'image/png', base64: png.toString('base64'),
      width: header.width, height: header.height,
      info: `GSA 首帧完整拼接画布 · ${decoded.tilesAcross}×${decoded.tilesDown} tile records · ${header.frames} declared frame(s)`,
    };
  }

  if (isDimgCandidate(buffer)) {
    try {
      return renderDimgFrame(buffer, options);
    } catch (error) {
      return hexView(buffer, `DIMG/IANI preview unavailable: ${error.message}`);
    }
  }

  const image = browserImage(buffer, name);
  if (image) {
    if (!validDimensions(image.width, image.height)) return hexView(buffer, `${image.format} dimensions exceed preview limits`);
    if (image.format === 'PNG') {
      try {
        const decoded = PNG.sync.read(buffer, { maxChunkSize: MAX_INPUT_BYTES });
        if (decoded.width !== image.width || decoded.height !== image.height) return hexView(buffer, 'PNG dimensions are inconsistent');
      } catch (_) {
        return hexView(buffer, 'PNG data is malformed');
      }
    }
    return { kind: 'image', mime: image.mime, base64: buffer.toString('base64'), width: image.width, height: image.height, info: image.format };
  }

  const audio = audioMime(buffer);
  if (audio === 'audio/midi') return hexView(buffer, 'MIDI detected; playback depends on the platform codec or synthesizer');
  if (audio) return { kind: 'audio', mime: audio, base64: buffer.toString('base64'), info: `${audio} · ${buffer.length} bytes` };

  const textResult = decodeText(buffer, name);
  if (textResult !== null) {
    const truncated = textResult.text.length > MAX_TEXT_CHARS;
    return { kind: 'text', encoding: textResult.encoding, text: truncated ? `${textResult.text.slice(0, MAX_TEXT_CHARS)}\n… text truncated` : textResult.text, info: truncated ? `${textResult.encoding} text · truncated at ${MAX_TEXT_CHARS} characters` : `${textResult.encoding} text · ${buffer.length} bytes` };
  }

  const dimgLike = buffer.length >= 8 && buffer.readUInt32LE(0) === 440815953;
  return hexView(buffer, dimgLike ? 'DIMG/IANI frame preview is unsupported; showing raw bytes' : `${buffer.length} bytes · unsupported format`);
}

async function exportEditable(buffer, name) {
  ensureBuffer(buffer);
  const header = gsaHeader(buffer);
  if (!header) throw new Error('editable export currently supports GSA containers only');
  const decoded = decodeGsaFrameZero(buffer, header);
  const png = pngBuffer(decoded.record.width, decoded.record.height, decoded.rgba);
  const metadata = {
    format: 'fantasy-pkg-studio-editable-v1',
    sourceFormat: 'GSA',
    sourceName: String(name || ''),
    width: decoded.record.width,
    height: decoded.record.height,
    attribute: decoded.record.attribute,
    pitch: decoded.record.pitch,
    frameIndex: 0,
    originalBase64: buffer.toString('base64'),
  };
  return {
    files: [
      { suffix: '.png', data: png },
      { suffix: '.metadata.json', data: Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`, 'utf8') },
    ],
    info: `GSA 首个图块/记录（非完整动画或拼接图）导出为可编辑 PNG；元数据保留原始容器字节和结构（${buffer.length} 字节）。`,
  };
}

function encodeGsaPixels(png, record) {
  const output = Buffer.alloc(record.payloadLength);
  // Copy padding and any unaddressed payload bytes so the only changed bytes are pixel samples.
  output.set(record.originalPayload);
  for (let y = 0; y < record.height; y += 1) {
    let source = y * record.width * 4;
    let destination = y * record.pitch;
    for (let x = 0; x < record.width; x += 1) {
      const red = png.data[source];
      const green = png.data[source + 1];
      const blue = png.data[source + 2];
      const alpha = png.data[source + 3];
      if (record.attribute === 0) {
        if (red % 8 || green % 8 || blue % 8 || (alpha !== 0 && alpha !== 255)) {
          throw new Error('PNG contains colors that GSA RGB5551 cannot represent exactly');
        }
        const r5 = red >> 3;
        const g5 = green >> 3;
        const b5 = blue >> 3;
        output[destination] = b5 | ((g5 & 7) << 5);
        // GsaDecoder.ReadColor treats high-byte bit 6 as the top red bit, so preserve its
        // pixel meaning from the edited PNG instead of forcing it to zero.
        output[destination + 1] = ((alpha === 0 ? 0 : 0x80) | (r5 << 2) | (g5 >> 3));
        destination += 2;
      } else if (record.attribute === 1) {
        if ([red, green, blue, alpha].some(value => value % 17 !== 0)) {
          throw new Error('PNG contains colors that GSA RGBA4444 cannot represent exactly');
        }
        const r4 = red / 17;
        const g4 = green / 17;
        const b4 = blue / 17;
        const a4 = alpha / 17;
        output[destination] = (g4 << 4) | b4;
        output[destination + 1] = (a4 << 4) | r4;
        destination += 2;
      } else if (record.attribute === 2) {
        output[destination] = blue;
        output[destination + 1] = green;
        output[destination + 2] = red;
        output[destination + 3] = alpha;
        destination += 4;
      } else {
        throw new Error('unsupported GSA pixel attribute');
      }
      source += 4;
    }
  }
  return output;
}

async function importEditable(originalBuffer, pngBufferInput, name) {
  ensureBuffer(originalBuffer);
  if (!Buffer.isBuffer(pngBufferInput)) throw new TypeError('pngBuffer must be a Buffer');
  if (pngBufferInput.length > MAX_INPUT_BYTES) throw new Error('PNG exceeds the 64 MiB import limit');
  const header = gsaHeader(originalBuffer);
  if (!header) throw new Error('editable import currently supports GSA containers only');
  const record = readGsaRecord(originalBuffer, header.dataOffset);
  if (!record) throw new Error('GSA 首个图块/记录（非完整动画或拼接图）格式不受支持或已损坏');
  const dimensions = pngDimensions(pngBufferInput);
  if (!dimensions || !validDimensions(dimensions.width, dimensions.height)) throw new Error('input must be a valid, bounded PNG');
  if (dimensions.width !== record.width || dimensions.height !== record.height) {
    throw new Error(`PNG dimensions must remain ${record.width}×${record.height}`);
  }
  let png;
  try {
    png = PNG.sync.read(pngBufferInput, { maxChunkSize: MAX_INPUT_BYTES });
  } catch (error) {
    throw new Error(`could not decode PNG: ${error.message}`);
  }
  if (png.width !== record.width || png.height !== record.height || png.data.length !== record.width * record.height * 4) {
    throw new Error('decoded PNG dimensions or pixel data do not match the source GSA frame');
  }
  record.originalPayload = originalBuffer.subarray(record.payloadOffset, record.endOffset);
  const payload = encodeGsaPixels(png, record);
  const result = Buffer.from(originalBuffer);
  payload.copy(result, record.payloadOffset);
  return result;
}

module.exports = { makePreview, exportEditable, importEditable };
