'use strict';

const MAX_INPUT_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 64;
const MAX_VALUE_NODES = 200000;
const MAX_LIST_ITEMS = 50000;
const MAX_STRING_LENGTH = 4096;
const MAX_LAYERS = 256;
const MAX_KEYFRAMES_PER_LAYER = 4096;
const MAX_TOTAL_KEYFRAMES = 16384;
const PAGE_SIZE = 100;

function fail(message) {
  throw new Error(`EFF 结构预览失败：${message}`);
}

function decodeIso88591(buffer) {
  // Match the game's Encoding.GetEncoding("ISO-8859-1"), rather than Node's
  // WHATWG "latin1" alias (which decodes some 0x80–0x9F bytes as Windows-1252).
  const pieces = [];
  const chunkSize = 8192;
  for (let start = 0; start < buffer.length; start += chunkSize) {
    const end = Math.min(start + chunkSize, buffer.length);
    const codes = new Array(end - start);
    for (let index = start; index < end; index++) codes[index - start] = buffer[index];
    pieces.push(String.fromCharCode(...codes));
  }
  return pieces.join('');
}

function parseSourceValue(text) {
  let position = 0;
  let nodes = 0;

  function skipWhitespace() {
    while (position < text.length) {
      const character = text[position];
      if (character !== ' ' && character !== '\t' && character !== '\r' && character !== '\n') break;
      position++;
    }
  }

  function parseValue(depth) {
    skipWhitespace();
    if (position >= text.length) fail('值意外结束');
    if (depth > MAX_DEPTH) fail(`嵌套超过 ${MAX_DEPTH} 层`);
    if (++nodes > MAX_VALUE_NODES) fail(`值数量超过 ${MAX_VALUE_NODES} 上限`);

    const first = text[position];
    if (first === '\'' || first === '"') {
      const quote = first;
      const start = ++position;
      while (position < text.length && text[position] !== quote) position++;
      if (position >= text.length) fail('字符串引号未闭合');
      const value = text.slice(start, position);
      position++;
      if (value.length > MAX_STRING_LENGTH) fail(`字符串超过 ${MAX_STRING_LENGTH} 字符上限`);
      return value;
    }

    if (first === '[' || first === '(') {
      const closing = first === '(' ? ')' : ']';
      position++;
      const values = [];
      while (true) {
        skipWhitespace();
        if (position >= text.length) fail(`列表缺少 ${closing}`);
        if (text[position] === closing) {
          position++;
          return values;
        }
        if (text[position] === ',' ) {
          position++;
          continue;
        }
        if (values.length >= MAX_LIST_ITEMS) fail(`列表超过 ${MAX_LIST_ITEMS} 项上限`);
        const before = position;
        values.push(parseValue(depth + 1));
        if (position <= before) fail('解析器未能前进');
      }
    }

    const match = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(position));
    if (!match) fail(`未知值语法，位置 ${position}`);
    position += match[0].length;
    const value = Number(match[0]);
    if (!Number.isFinite(value)) fail(`数值超出有限范围，位置 ${position - match[0].length}`);
    return value;
  }

  const root = parseValue(0);
  skipWhitespace();
  if (position !== text.length) fail(`根值后存在未消费内容，位置 ${position}`);
  return root;
}

function sourceNumber(value) {
  return typeof value === 'number' ? value : 0;
}

function sourceInt(value) {
  return Math.trunc(sourceNumber(value));
}

function sourceList(value) {
  return Array.isArray(value) ? value : null;
}

function safeText(value) {
  let result = '';
  for (const character of String(value)) {
    const code = character.codePointAt(0);
    if (code === 0x5c) result += '\\\\';
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
      result += code <= 0xff
        ? `\\x${code.toString(16).padStart(2, '0')}`
        : `\\u${code.toString(16).padStart(4, '0')}`;
    } else result += character;
  }
  return result;
}

function displayNumber(value) {
  if (Object.is(value, -0)) return '0';
  return String(value);
}

function vector(values, length) {
  return Array.from({ length }, (_, index) => displayNumber(sourceNumber(values?.[index]))).join(', ');
}

function normalizeTemplate(root) {
  if (!Array.isArray(root) || root.length < 2) fail('根值必须是至少包含标记值和层列表的数组');
  const sourceLayers = sourceList(root[1]);
  if (!sourceLayers) fail('根数组第 2 项不是层列表');
  if (sourceLayers.length > MAX_LAYERS) fail(`层数超过 ${MAX_LAYERS} 上限`);

  let loopFromTail = 0;
  const loop = sourceList(root[2]);
  if (root.length > 2 && loop && loop.length > 0) loopFromTail = sourceInt(loop[0]);

  let lifeMs = 0;
  let totalKeyframes = 0;
  let skippedLayerShapes = 0;
  let skippedKeyframeShapes = 0;
  const layers = [];

  for (let sourceIndex = 0; sourceIndex < sourceLayers.length; sourceIndex++) {
    const sourceLayer = sourceList(sourceLayers[sourceIndex]);
    if (!sourceLayer || sourceLayer.length < 2) {
      skippedLayerShapes++;
      continue;
    }
    const header = sourceList(sourceLayer[0]);
    const sourceKeyframes = sourceList(sourceLayer[1]);
    if (!header || !sourceKeyframes) {
      skippedLayerShapes++;
      continue;
    }
    if (sourceKeyframes.length > MAX_KEYFRAMES_PER_LAYER) {
      fail(`第 ${sourceIndex + 1} 层关键帧数超过 ${MAX_KEYFRAMES_PER_LAYER} 上限`);
    }

    let sprite = '';
    let blend = 0;
    let speed = 100;
    let cField = 0;
    if (header.length > 1) {
      const spriteValues = sourceList(header[1]);
      if (spriteValues && spriteValues.length > 0 && typeof spriteValues[0] === 'string') {
        sprite = spriteValues[0];
        if (spriteValues.length > 1) blend = sourceInt(spriteValues[1]);
        if (spriteValues.length > 2) speed = sourceNumber(spriteValues[2]);
        if (spriteValues.length > 3) cField = sourceNumber(spriteValues[3]);
      }
    }

    let blendMode = 0;
    if (header.length > 2) {
      const blendValues = sourceList(header[2]);
      if (blendValues && blendValues.length > 0) blendMode = sourceInt(blendValues[0]);
    }

    let offX = 0;
    let offY = 0;
    if (header.length > 5) {
      const offset = sourceList(header[header.length - 1]);
      if (offset && offset.length > 1) {
        offX = sourceNumber(offset[0]);
        offY = sourceNumber(offset[1]);
      }
    }

    const keyframes = [];
    for (let frameIndex = 0; frameIndex < sourceKeyframes.length; frameIndex++) {
      const sourceFrame = sourceList(sourceKeyframes[frameIndex]);
      if (!sourceFrame || sourceFrame.length < 2) {
        skippedKeyframeShapes++;
        continue;
      }
      const values = sourceList(sourceFrame[1]);
      if (!values || values.length < 5) {
        skippedKeyframeShapes++;
        continue;
      }
      if (++totalKeyframes > MAX_TOTAL_KEYFRAMES) fail(`关键帧总数超过 ${MAX_TOTAL_KEYFRAMES} 上限`);

      const time = sourceNumber(sourceFrame[0]);
      const position = sourceList(values[0]);
      const scale = sourceList(values[1]);
      const color = sourceList(values[3]);
      const pos = position && position.length > 2 ? [0, 1, 2].map((i) => sourceNumber(position[i])) : [0, 0, 0];
      const scaleXY = scale && scale.length > 1 ? [0, 1].map((i) => sourceNumber(scale[i])) : [0, 0];
      const rgb = color && color.length > 2 ? [0, 1, 2].map((i) => sourceNumber(color[i])) : [255, 255, 255];
      const rotation = sourceNumber(values[2]);
      const alpha = sourceNumber(values[4]);

      keyframes.push({
        time,
        position: pos,
        scale: scaleXY,
        rotation,
        color: rgb,
        alpha,
      });
      if (lifeMs < time) lifeMs = time;
    }

    // EffectPlayer.Parse publishes only layers with keyframes and a non-empty sprite name.
    if (keyframes.length > 0 && sprite.length > 0) {
      layers.push({ sourceIndex: sourceIndex + 1, sprite, blend, speed, cField, blendMode, offX, offY, keyframes });
    }
  }

  return {
    rootMarker: root[0],
    loopFromTail,
    lifeMs: lifeMs + 100,
    layers,
    totalKeyframes,
    skippedLayerShapes,
    skippedKeyframeShapes,
  };
}

function layerRows(layer, outputIndex) {
  const rows = [
    `层 ${outputIndex}（源层 ${layer.sourceIndex}）：sprite=${safeText(layer.sprite)}；blend=${layer.blend}；speed=${displayNumber(layer.speed)} ms/frame；cField=${displayNumber(layer.cField)}；blendMode=${layer.blendMode}；offset=(${displayNumber(layer.offX)}, ${displayNumber(layer.offY)})；关键帧=${layer.keyframes.length}`,
  ];
  for (let index = 0; index < layer.keyframes.length; index++) {
    const frame = layer.keyframes[index];
    const color = frame.color.map(displayNumber).join(', ');
    rows.push(
      `  层 ${outputIndex} / 帧 ${index + 1}：time=${displayNumber(frame.time)} ms；position=(${vector(frame.position, 3)})；scale=(${vector(frame.scale, 2)})；rotation=${displayNumber(frame.rotation)}；color=(${color}) / 255；alpha=${displayNumber(frame.alpha)}`,
    );
  }
  return rows;
}

function makeEffectPreview(buffer, name, options = {}) {
  if (!/\.eff$/i.test(String(name ?? ''))) return null;
  if (!Buffer.isBuffer(buffer)) throw new TypeError('effect preview requires a Buffer');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('EFF 结构预览超过 2 MiB 上限');
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('EFF 分页参数无效');
  const page = options.page === undefined ? 0 : options.page;
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('EFF 页码必须是非负安全整数');
  const parsed = parseEffect(buffer, name);

  const rows = parsed.layers.flatMap((layer, index) => layerRows(layer, index + 1));
  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  if (page >= pageCount) throw new Error(`EFF 页码超出范围（共 ${pageCount} 页）`);
  const start = page * PAGE_SIZE;
  const pageRows = rows.slice(start, start + PAGE_SIZE);
  return {
    kind: 'text',
    text: pageRows.length ? pageRows.join('\n') : '（无可显示层）',
    info: `${String(name)} · 根标记=${safeText(JSON.stringify(parsed.rootMarker))} · 层=${parsed.layers.length} · 有效关键帧=${parsed.totalKeyframes} · lifeMs=${displayNumber(parsed.lifeMs)} · loopFromTail=${parsed.loopFromTail} · 生命周期按 EffectPlayer.Parse 取 max(0, keyframe time) + 100 ms；sprite 仅显示引用名。${parsed.skippedLayerShapes || parsed.skippedKeyframeShapes ? ` 跳过无效形状：层 ${parsed.skippedLayerShapes} 项，关键帧 ${parsed.skippedKeyframeShapes} 项。` : ''}`,
    page,
    pageCount,
    pageSize: PAGE_SIZE,
    layerCount: parsed.layers.length,
    keyframeCount: parsed.totalKeyframes,
    lifeMs: parsed.lifeMs,
  };
}

function parseEffect(buffer, name) {
  if (!/\.eff$/i.test(String(name ?? ''))) return null;
  if (!Buffer.isBuffer(buffer)) throw new TypeError('effect preview requires a Buffer');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('EFF 结构预览超过 2 MiB 上限');
  return normalizeTemplate(parseSourceValue(decodeIso88591(buffer)));
}

module.exports = { makeEffectPreview, parseEffect, PAGE_SIZE, MAX_INPUT_BYTES };
