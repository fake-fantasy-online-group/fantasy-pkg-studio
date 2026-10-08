'use strict';

const { PNG } = require('pngjs');
const { parseEffect } = require('./effect-preview.cjs');
const { renderFrame, inspectAnimation } = require('./dimg.cjs');

const MAX_LAYERS = 64;
const MAX_ASSETS = 64;
const MAX_FRAMES_PER_ASSET = 128;
const MAX_DECODED_PIXELS = 16 * 1024 * 1024;
const MAX_PNG_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 2048;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_LIFE_MS = 60000;
const SAMPLE_HZ = 30;
const MAX_CANVAS_SPAN = 16384;
const MAX_ISSUES = 512;

function f32(value, label) {
  const converted = Math.fround(Number(value));
  if (!Number.isFinite(converted)) throw new Error(`${label} 超出有限单精度范围`);
  return converted;
}

function resolveMagicPath(sprite) {
  if (typeof sprite !== 'string' || !/^magic[+-]?\d+$/.test(sprite)) return null;
  const id = Number(sprite.slice(5));
  if (!Number.isInteger(id) || id < -2147483648 || id > 2147483647) return null;
  const digits = String(Math.abs(id)).padStart(4, '0');
  return `magic/magic/magic${id < 0 ? '-' : ''}${digits}.gso`;
}

function issue(issues, path, reason) {
  if (issues.length < MAX_ISSUES) issues.push({ ...(path ? { path } : {}), reason });
}

function normalizeLayer(layer) {
  const keyframes = layer.keyframes.map((frame, index) => ({
    time: f32(frame.time, `关键帧${index + 1}时间`),
    position: frame.position.map((value, axis) => f32(value, `关键帧${index + 1}位置${axis}`)),
    scale: frame.scale.map((value, axis) => f32(value, `关键帧${index + 1}缩放${axis}`)),
    rotation: f32(frame.rotation, `关键帧${index + 1}旋转`),
    color: frame.color.map((value, channel) => f32(value, `关键帧${index + 1}颜色${channel}`)),
    alpha: f32(frame.alpha, `关键帧${index + 1}透明度`),
  }));
  return {
    sourceIndex: layer.sourceIndex,
    sprite: layer.sprite,
    blend: layer.blend,
    speedMs: Math.max(f32(layer.speed, 'sprite帧间隔'), 1),
    cField: f32(layer.cField, 'cField'),
    blendMode: layer.blendMode,
    offset: [f32(layer.offX, 'offsetX'), f32(layer.offY, 'offsetY')],
    keyframes,
  };
}

function buildMoments(times, values) {
  const count = times.length;
  const moments = new Array(count).fill(0);
  if (count < 3) return moments;
  const diagonal = new Array(count).fill(0);
  const upper = new Array(count).fill(0);
  const lower = new Array(count).fill(0);
  const right = new Array(count).fill(0);
  diagonal[0] = 1;
  diagonal[count - 1] = 1;
  for (let index = 1; index < count - 1; index += 1) {
    const before = Math.fround(times[index] - times[index - 1]);
    const after = Math.fround(times[index + 1] - times[index]);
    lower[index] = before;
    diagonal[index] = Math.fround(2 * Math.fround(before + after));
    upper[index] = after;
    right[index] = Math.fround(6 * Math.fround(
      Math.fround((values[index + 1] - values[index]) / Math.max(after, 0.0001)) -
      Math.fround((values[index] - values[index - 1]) / Math.max(before, 0.0001))));
  }
  for (let index = 1; index < count; index += 1) {
    const factor = diagonal[index - 1] === 0 ? 0 : lower[index] / diagonal[index - 1];
    diagonal[index] = Math.fround(diagonal[index] - factor * upper[index - 1]);
    right[index] = Math.fround(right[index] - factor * right[index - 1]);
  }
  moments[count - 1] = diagonal[count - 1] === 0 ? 0 : Math.fround(right[count - 1] / diagonal[count - 1]);
  for (let index = count - 2; index >= 0; index -= 1) {
    moments[index] = diagonal[index] === 0 ? 0 : Math.fround(
      (right[index] - upper[index] * moments[index + 1]) / diagonal[index]);
  }
  return moments;
}

function evalSpline(times, values, moments, time) {
  const count = times.length;
  if (time <= times[0]) return values[0];
  if (time >= times[count - 1]) return values[count - 1];
  let index = 0;
  while (index < count - 2 && times[index + 1] < time) index += 1;
  const width = Math.fround(times[index + 1] - times[index]);
  if (width <= 0) return values[index];
  const left = Math.fround((times[index + 1] - time) / width);
  const right = Math.fround((time - times[index]) / width);
  const linear = Math.fround(left * values[index] + right * values[index + 1]);
  const curve = Math.fround((
    Math.fround((left * left * left - left) * moments[index]) +
    Math.fround((right * right * right - right) * moments[index + 1])) * width * width / 6);
  return Math.fround(linear + curve);
}

function lerp(a, b, ratio) {
  const amount = Math.min(1, Math.max(0, ratio));
  return Math.fround(a + (b - a) * amount);
}

function buildLayerSampler(layer) {
  const keyframes = layer.keyframes;
  const times = keyframes.map(frame => frame.time);
  const positionValues = [0, 1, 2].map(axis => keyframes.map(frame => frame.position[axis]));
  const positionMoments = keyframes.length > 2
    ? positionValues.map(values => buildMoments(times, values))
    : null;
  const sample = time => {
    let before;
    let after;
    let ratio = 0;
    if (time <= keyframes[0].time) {
      before = after = keyframes[0];
    } else if (time >= keyframes[keyframes.length - 1].time || keyframes.length < 2) {
      before = after = keyframes[keyframes.length - 1];
    } else {
      let found = false;
      for (let index = 0; index < keyframes.length - 1; index += 1) {
        const current = keyframes[index];
        const next = keyframes[index + 1];
        if (current.time <= time && time <= next.time) {
          before = current;
          after = next;
          const width = next.time - current.time;
          ratio = width > 0.01 ? (time - current.time) / width : 0;
          found = true;
          break;
        }
      }
      if (!found) before = after = keyframes[keyframes.length - 1];
    }

    const position = before.position.map((value, axis) => positionMoments
      ? evalSpline(times, positionValues[axis], positionMoments[axis], time)
      : lerp(value, after.position[axis], ratio));
    const scale = before.scale.map((value, axis) => lerp(value, after.scale[axis] ?? 0, ratio));
    const color = before.color.map((value, channel) => lerp(value, after.color[channel] ?? 255, ratio) / 255);
    return {
      position,
      scale,
      rotation: lerp(before.rotation, after.rotation, ratio),
      color,
      alpha: lerp(before.alpha, after.alpha, ratio),
    };
  };
  return { sample, lastTime: keyframes[keyframes.length - 1].time };
}

function autoIntensityMap(asset, firstPng) {
  const frame = asset._firstFrameGeometry;
  if (!frame) return false;
  const png = PNG.sync.read(firstPng, { maxChunkSize: MAX_PNG_BYTES });
  const framePixels = frame.width * frame.height;
  const step = Math.max(Math.floor(framePixels / 200000), 1);
  const left = frame.left - asset.canvas.originX;
  const top = frame.top - asset.canvas.originY;
  let visible = 0;
  let dark = 0;
  for (let index = 0; index < framePixels; index += step) {
    const x = left + (index % frame.width);
    // ToTexture stores source rows bottom-up in Unity's GetPixels32 linear order.
    const y = top + frame.height - 1 - Math.floor(index / frame.width);
    const offset = (y * png.width + x) * 4;
    const alpha = png.data[offset + 3];
    if (alpha > 8) {
      visible += 1;
      if (png.data[offset] < 25 && png.data[offset + 1] < 25 && png.data[offset + 2] < 25) dark += 1;
    }
  }
  return visible > 199 && visible * 40 <= dark * 100;
}

function assetFrameAnchor(frame, metadata) {
  const { originX, originY } = metadata.canvas;
  const zeroBoundCenter = metadata.global.boundCx === 0 && metadata.global.boundCy === 0;
  if (zeroBoundCenter) {
    return [
      frame.left - originX + frame.width / 2,
      frame.top - originY + frame.height / 2,
    ];
  }
  return [
    frame.left - originX + (metadata.global.boundCx - frame.left) * metadata.tier,
    frame.top - originY + (metadata.global.boundCy - frame.top) * metadata.tier,
  ];
}

function resolveBlend(mode, autoIntensity) {
  if (mode === 1 || mode === 2) return 'additive';
  if (mode === 3) return 'max';
  if (mode !== 0) return 'alpha';
  return autoIntensity ? 'additive' : 'alpha';
}

function finitePose(pose) {
  return [...pose.position, ...pose.scale, pose.rotation, ...pose.color, pose.alpha]
    .every(Number.isFinite);
}

async function decodeAsset(path, readRelated, budget) {
  if (typeof readRelated !== 'function') throw new Error('工程读取接口不可用');
  const value = await readRelated(path);
  if (value == null) throw new Error('工程中未找到该GSO素材');
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  if (bytes.length > MAX_INPUT_BYTES) throw new Error('GSO 超过64MiB特效素材读取上限');
  const metadata = inspectAnimation(bytes);
  if (metadata.family !== 'DIMG') throw new Error(`EffectPlayer魔法素材要求DIMG，实际为${metadata.family}`);
  if (metadata.framesPerDirection < 1 || metadata.directions < 1) throw new Error('GSO方向或帧数元数据无效');
  if (metadata.canvas.width > MAX_IMAGE_DIMENSION || metadata.canvas.height > MAX_IMAGE_DIMENSION) {
    throw new Error(`GSO稳定画布${metadata.canvas.width}×${metadata.canvas.height}超过${MAX_IMAGE_DIMENSION}px边长限制`);
  }
  const sourceFrames = metadata.frames.slice(0, metadata.framesPerDirection).filter(frame => !frame.empty);
  if (sourceFrames.length > MAX_FRAMES_PER_ASSET) {
    throw new Error(`首方向含${sourceFrames.length}张非空帧，超过${MAX_FRAMES_PER_ASSET}帧素材上限`);
  }
  const framePixels = metadata.canvas.width * metadata.canvas.height;
  if (framePixels * sourceFrames.length > MAX_DECODED_PIXELS - budget.decodedPixels) {
    throw new Error('GSO解码后像素总量将超过16M上限');
  }

  const frames = [];
  let pngBytes = 0;
  let firstPng = null;
  for (const sourceFrame of sourceFrames) {
    budget.decodedPixels += framePixels;
    const rendered = renderFrame(bytes, { frameIndex: sourceFrame.frameIndex });
    if (rendered.kind !== 'animation' || rendered.frameIndex !== sourceFrame.frameIndex ||
        rendered.width !== metadata.canvas.width || rendered.height !== metadata.canvas.height) {
      throw new Error(`GSO帧${sourceFrame.frameIndex}响应与解析元数据不匹配`);
    }
    const encoded = Buffer.from(rendered.base64, 'base64');
    budget.pngBytes += encoded.length;
    pngBytes += encoded.length;
    if (budget.pngBytes > MAX_PNG_BYTES) {
      throw new Error('GSO PNG总量将超过32MiB上限');
    }
    if (!firstPng) firstPng = encoded;
    frames.push({
      frameIndex: frames.length,
      sourceFrameIndex: sourceFrame.frameIndex,
      mime: 'image/png',
      base64: rendered.base64,
      width: rendered.width,
      height: rendered.height,
      anchor: assetFrameAnchor(sourceFrame, metadata),
    });
  }
  if (frames.length === 0) throw new Error('GSO首方向没有EffectPlayer可用的非空sprite帧');

  const asset = {
    path,
    tier: metadata.tier,
    canvas: metadata.canvas,
    boundCenter: [metadata.global.boundCx, metadata.global.boundCy],
    directions: metadata.directions,
    framesPerDirection: metadata.framesPerDirection,
    selectedDirection: 0,
    frames,
    _firstFrameGeometry: sourceFrames[0],
    _autoIntensity: autoIntensityMap({ _firstFrameGeometry: sourceFrames[0], canvas: metadata.canvas }, firstPng),
    _decodedPixels: framePixels * frames.length,
    _pngBytes: pngBytes,
  };
  if (metadata.directions > 1) {
    asset.directionIssue = `GSO 有${metadata.directions}个方向；EffectPlayer默认播放路径取方向0`;
  }
  return asset;
}

function publicAsset(asset, id) {
  return {
    id,
    path: asset.path,
    tier: asset.tier,
    canvas: asset.canvas,
    boundCenter: asset.boundCenter,
    directions: asset.directions,
    framesPerDirection: asset.framesPerDirection,
    selectedDirection: 0,
    frames: asset.frames,
  };
}

function addPoseBounds(bounds, pose, layer, asset) {
  const frame = asset.frames[pose.assetFrameIndex];
  if (!frame) return;
  const tier = Math.max(asset.tier, 1);
  const width = frame.width / tier;
  const height = frame.height / tier;
  const anchorX = frame.anchor[0] / tier;
  const anchorY = frame.anchor[1] / tier;
  const px = pose.position[0] + layer.offset[0];
  const py = pose.position[1] * 0.5 + layer.offset[1] - pose.position[2];
  const radians = -pose.rotation * Math.PI / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const points = [
    [-anchorX, -anchorY], [width - anchorX, -anchorY],
    [-anchorX, height - anchorY], [width - anchorX, height - anchorY],
  ];
  for (const [x, y] of points) {
    const scaledX = x * pose.scale[0];
    const scaledY = y * pose.scale[1];
    const transformedX = px + scaledX * cos - scaledY * sin;
    const transformedY = py + scaledX * sin + scaledY * cos;
    if (!Number.isFinite(transformedX) || !Number.isFinite(transformedY)) throw new Error('特效画布坐标超出有限范围');
    bounds.minX = Math.min(bounds.minX, transformedX);
    bounds.minY = Math.min(bounds.minY, transformedY);
    bounds.maxX = Math.max(bounds.maxX, transformedX);
    bounds.maxY = Math.max(bounds.maxY, transformedY);
  }
}

async function makeEffectScene(buffer, name, { readRelated } = {}) {
  const template = parseEffect(buffer, name);
  if (template === null) return null;
  if (!Buffer.isBuffer(buffer) || buffer.length > 2 * 1024 * 1024) throw new Error('EFF场景输入超过2MiB上限');

  const issues = [];
  let partial = false;
  if (template.skippedLayerShapes || template.skippedKeyframeShapes) {
    issue(issues, null, `EFF源含无效形状：层${template.skippedLayerShapes}项、关键帧${template.skippedKeyframeShapes}项；按客户端解析规则忽略`);
  }
  if (template.layers.length > MAX_LAYERS) {
    partial = true;
    issue(issues, null, `有效层数${template.layers.length}超过${MAX_LAYERS}层预览上限；仅处理前${MAX_LAYERS}层`);
  }
  if (template.loopFromTail !== 0) {
    issue(issues, null, `loopFromTail=${template.loopFromTail} 已保留；当前EffectPlayer.Play/Update路径不消费此字段`);
  }

  let lifeMs;
  try {
    lifeMs = f32(template.lifeMs, 'EFF lifeMs');
  } catch (error) {
    lifeMs = null;
    partial = true;
    issue(issues, null, error.message);
  }
  const timelineComplete = lifeMs !== null && lifeMs <= MAX_LIFE_MS;
  if (!timelineComplete) {
    partial = true;
    issue(issues, null, `EFF lifeMs ${lifeMs ?? '无效'} 超过${MAX_LIFE_MS}ms姿态采样上限；保留完整关键帧，不生成截断播放轨迹`);
  }

  const assets = [];
  const assetByPath = new Map();
  const autoIntensityByAssetId = [];
  const budget = { decodedPixels: 0, pngBytes: 0 };
  const layers = [];
  const layerLimit = Math.min(template.layers.length, MAX_LAYERS);
  const frameStep = 1000 / SAMPLE_HZ;
  for (let layerIndex = 0; layerIndex < layerLimit; layerIndex += 1) {
    const sourceLayer = template.layers[layerIndex];
    let layer;
    try {
      layer = normalizeLayer(sourceLayer);
    } catch (error) {
      partial = true;
      issue(issues, null, `EFF第${sourceLayer.sourceIndex}层参数不可安全采样：${error.message}`);
      continue;
    }

    const spritePath = resolveMagicPath(layer.sprite);
    let assetId = null;
    let asset = null;
    if (!spritePath) {
      partial = true;
      issue(issues, null, `EFF第${layer.sourceIndex}层sprite=${layer.sprite}不符合已确认magic整数素材引用；未猜测路径`);
    } else if (assetByPath.has(spritePath)) {
      assetId = assetByPath.get(spritePath);
      asset = assets[assetId];
    } else if (assets.length >= MAX_ASSETS) {
      partial = true;
      issue(issues, spritePath, `不同GSO素材超过${MAX_ASSETS}项上限`);
    } else {
      try {
        const decoded = await decodeAsset(spritePath, readRelated, budget);
        assetId = assets.length;
        asset = publicAsset(decoded, assetId);
        assetByPath.set(spritePath, assetId);
        assets.push(asset);
        autoIntensityByAssetId[assetId] = decoded._autoIntensity;
        if (decoded.directionIssue) issue(issues, spritePath, decoded.directionIssue);
        decoded._firstFrameGeometry = null;
      } catch (error) {
        partial = true;
        issue(issues, spritePath, error.message);
        assetByPath.set(spritePath, null);
      }
    }

    const sampler = buildLayerSampler(layer);
    const keyframes = layer.keyframes;
    const poses = [];
    let poseBoundsFailed = false;
    if (timelineComplete) {
      const sampleCount = Math.ceil(lifeMs * SAMPLE_HZ / 1000);
      for (let sampleIndex = 0; sampleIndex < sampleCount; sampleIndex += 1) {
        const timeMs = sampleIndex * frameStep;
        const pose = sampler.sample(timeMs);
        if (!finitePose(pose)) {
          partial = true;
          issue(issues, spritePath, `EFF第${layer.sourceIndex}层在${timeMs}ms产生非有限姿态；已跳过该层完整轨迹`);
          poseBoundsFailed = true;
          break;
        }
        const assetFrameIndex = asset?.frames.length
          ? Math.trunc(timeMs / layer.speedMs) % asset.frames.length
          : null;
        const visible = timeMs <= sampler.lastTime;
        const outputPose = {
          timeMs,
          visible,
          assetFrameIndex,
          position: pose.position,
          scale: pose.scale,
          rotation: pose.rotation,
          color: pose.color,
          alpha: pose.alpha,
        };
        if (visible && asset && assetFrameIndex !== null) {
          try {
            addPoseBounds(layer._bounds ||= { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity }, outputPose, layer, asset);
          } catch (error) {
            partial = true;
            issue(issues, spritePath, `EFF第${layer.sourceIndex}层画布边界失败：${error.message}`);
            layer._bounds = null;
            poseBoundsFailed = true;
            break;
          }
        }
        poses.push(outputPose);
      }
    }
    if (poseBoundsFailed) poses.length = 0;
    const publicLayer = {
      sourceIndex: layer.sourceIndex,
      sprite: layer.sprite,
      spritePath,
      assetId,
      blend: layer.blend,
      blendMode: layer.blendMode,
      resolvedBlend: resolveBlend(layer.blendMode,
        assetId === null ? false : autoIntensityByAssetId[assetId]),
      speedMs: layer.speedMs,
      frameMs: layer.speedMs,
      frameMode: 'loop',
      cField: layer.cField,
      offset: layer.offset,
      keyframes,
      poses,
    };
    if (layer._bounds) publicLayer.bounds = {
      minX: layer._bounds.minX,
      minY: layer._bounds.minY,
      width: Math.max(0, layer._bounds.maxX - layer._bounds.minX),
      height: Math.max(0, layer._bounds.maxY - layer._bounds.minY),
    };
    layers.push(publicLayer);
  }

  const canvasBounds = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  const acceptedLayers = [];
  for (const layer of layers) {
    const bounds = layer.bounds;
    if (bounds && (bounds.width > MAX_CANVAS_SPAN || bounds.height > MAX_CANVAS_SPAN ||
        Math.abs(bounds.minX) > MAX_CANVAS_SPAN || Math.abs(bounds.minY) > MAX_CANVAS_SPAN ||
        Math.abs(bounds.minX + bounds.width) > MAX_CANVAS_SPAN ||
        Math.abs(bounds.minY + bounds.height) > MAX_CANVAS_SPAN)) {
      partial = true;
      issue(issues, layer.spritePath, `EFF第${layer.sourceIndex}层画布跨度超过${MAX_CANVAS_SPAN}预览单位；已跳过该层poses`);
      layer.poses = [];
      acceptedLayers.push(layer);
      continue;
    }
    if (bounds) {
      const union = {
        minX: Math.min(canvasBounds.minX, bounds.minX),
        minY: Math.min(canvasBounds.minY, bounds.minY),
        maxX: Math.max(canvasBounds.maxX, bounds.minX + bounds.width),
        maxY: Math.max(canvasBounds.maxY, bounds.minY + bounds.height),
      };
      if (union.maxX - union.minX > MAX_CANVAS_SPAN || union.maxY - union.minY > MAX_CANVAS_SPAN) {
        partial = true;
        issue(issues, layer.spritePath, `EFF第${layer.sourceIndex}层会使场景画布超过${MAX_CANVAS_SPAN}预览单位；已跳过该层poses`);
        layer.poses = [];
        acceptedLayers.push(layer);
        continue;
      }
      Object.assign(canvasBounds, union);
    }
    acceptedLayers.push(layer);
  }
  const hasBounds = Number.isFinite(canvasBounds.minX) && Number.isFinite(canvasBounds.minY);
  return {
    kind: 'effect-scene',
    lifeMs,
    loopFromTail: template.loopFromTail,
    sampleRateHz: SAMPLE_HZ,
    timelineComplete,
    coordinateSystem: 'EffectPlayer local; preview PPU=100; screen Y positive downward',
    canvas: {
      units: 'preview units (PPU=100)',
      bounds: hasBounds ? {
        minX: canvasBounds.minX,
        minY: canvasBounds.minY,
        width: Math.max(1, canvasBounds.maxX - canvasBounds.minX),
        height: Math.max(1, canvasBounds.maxY - canvasBounds.minY),
      } : { minX: 0, minY: 0, width: 1, height: 1 },
    },
    layers: acceptedLayers,
    assets,
    partial,
    issues: issues.length <= MAX_ISSUES ? issues : [
      ...issues.slice(0, MAX_ISSUES), { reason: `另有${issues.length - MAX_ISSUES}条问题未显示` },
    ],
    info: `EFF孤立特效场景 · 层${acceptedLayers.length} · 素材${assets.length} · lifeMs=${lifeMs ?? 'invalid'} · 姿态采样${SAMPLE_HZ}Hz${partial ? ' · partial' : ''}`,
  };
}

module.exports = { makeEffectScene };
