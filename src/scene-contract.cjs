'use strict';

const MAX_COORDINATE = 100000000;
const validNumber = value => Number.isFinite(value) && Math.abs(value) <= MAX_COORDINATE;
const validDimension = value => Number.isSafeInteger(value) && value > 0 && value <= 2048;

function transformPoint(matrix, x, y) {
  if (!validNumber(x) || !validNumber(y)) return null;
  const point = [matrix[0] * x + matrix[2] * y + matrix[4],
    matrix[1] * x + matrix[3] * y + matrix[5]];
  return point.every(validNumber) ? point : null;
}

// Apply one proven world-to-image transform to all gameplay layers. A diagnostic
// terrain-code grid deliberately has no such transform and must not receive them.
function attachMapLogic(scene, logic) {
  if (!scene || scene.kind !== 'map-scene' || !validDimension(scene.width) ||
      !validDimension(scene.height) || typeof scene.base64 !== 'string') {
    throw new Error('地图场景返回了无效画布');
  }
  const issues = [...(scene.issues || []), ...(logic?.issues || [])];
  const matrix = scene.worldToImage;
  const output = { ...scene, markers: [], collision: null };
  const rawMarkers = logic?.markers || [];
  if (!Array.isArray(rawMarkers) || rawMarkers.length > 10000) {
    throw new Error('地图逻辑标记数量无效或超过上限');
  }
  if (!Array.isArray(matrix) || matrix.length !== 6 || !matrix.every(validNumber) ||
      Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) < 1e-15) {
    if (rawMarkers.length || logic?.collision) {
      issues.push({ reason: '当前地面没有已确认的游戏坐标映射，逻辑图层未叠加；可从文件树查看原始资源。' });
    }
  } else {
    let invalidCount = 0;
    for (const marker of rawMarkers) {
      const point = transformPoint(matrix, marker.x, marker.y);
      if (!point || !['transfer', 'npc', 'spawn', 'trigger'].includes(marker.kind)) {
        invalidCount++;
        continue;
      }
      let polygon;
      if (marker.polygon) {
        if (!Array.isArray(marker.polygon) || marker.polygon.length < 3 || marker.polygon.length > 16) {
          invalidCount++;
          continue;
        }
        polygon = marker.polygon.map(p => Array.isArray(p) ? transformPoint(matrix, p[0], p[1]) : null);
        if (polygon.some(p => p === null)) { invalidCount++; continue; }
      }
      output.markers.push({ ...marker, x: point[0], y: point[1], polygon,
        details: [`游戏坐标：(${marker.x}, ${marker.y})`, marker.details].filter(Boolean).join('\n') });
    }
    if (invalidCount) issues.push({ reason: `${invalidCount} 个逻辑标记坐标无效，未叠加。` });
    const collision = logic?.collision;
    if (collision) {
      if (validDimension(collision.width) && validDimension(collision.height) &&
          validNumber(collision.worldWidth) && collision.worldWidth > 0 &&
          validNumber(collision.worldHeight) && collision.worldHeight > 0 &&
          typeof collision.base64 === 'string') {
        const sx = collision.worldWidth / collision.width;
        const sy = collision.worldHeight / collision.height;
        output.collision = { ...collision,
          transform: [matrix[0] * sx, matrix[1] * sx, matrix[2] * sy,
            matrix[3] * sy, matrix[4], matrix[5]] };
      } else issues.push({ reason: '通行图层尺寸或游戏坐标范围无效，未叠加。' });
    }
  }
  // Keep the status panel bounded even when many placements reference missing art.
  const distinct = new Map();
  for (const issue of issues) {
    if (!issue || typeof issue.reason !== 'string') continue;
    const key = `${issue.path || ''}\0${issue.reason}`;
    if (!distinct.has(key)) distinct.set(key, issue);
  }
  output.issues = [...distinct.values()].slice(0, 500);
  if (distinct.size > 500) output.issues.push({ reason: `另有 ${distinct.size - 500} 项问题未展开。` });
  return output;
}

module.exports = { attachMapLogic };
