'use strict';

const { PNG } = require('pngjs');
// SMF chunk/event layout: https://midi.org/standard-midi-files-specification
// A visual note timeline, not a synthesizer: sustain/pedal/instrument effects are not rendered.
function makeMidiPreview(data, name) {
  const recognized = data.length >= 4 && data.toString('ascii', 0, 4) === 'MThd';
  if (!recognized && !/\.(mid|midi)$/i.test(name)) return null;
  const fail = (message) => { throw new Error(`MIDI 预览：${message}`); };
  if (!recognized || data.length < 14) fail('文件头无效或截断');
  const headerSize = data.readUInt32BE(4);
  if (headerSize < 6 || headerSize > data.length - 8) fail('文件头长度无效');
  const format = data.readUInt16BE(8), trackCount = data.readUInt16BE(10), division = data.readUInt16BE(12);
  if (format > 2 || !trackCount || trackCount > 256 || (format === 0 && trackCount !== 1) || !division) fail('不支持的格式、轨道数或时间分辨率');
  if (division & 0x8000) {
    const fps = 256 - (division >> 8);
    if (![24, 25, 29, 30].includes(fps) || !(division & 255)) fail('SMPTE 时间分辨率无效');
  }
  const notes = [];
  let cursor = 8 + headerSize, events = 0, maxTick = 0, noteCount = 0, unclosed = 0;
  for (let track = 0; track < trackCount; track++) {
    if (cursor + 8 > data.length || data.toString('ascii', cursor, cursor + 4) !== 'MTrk') fail('轨道块无效或缺失');
    const end = cursor + 8 + data.readUInt32BE(cursor + 4);
    cursor += 8;
    if (end > data.length) fail('轨道数据截断');
    let tick = 0, running = 0, ended = false;
    const active = new Map();
    const byte = () => { if (cursor >= end) fail('事件数据截断'); return data[cursor++]; };
    const vlq = () => {
      let value = 0;
      for (let i = 0; i < 4; i++) { const b = byte(); value = value * 128 + (b & 127); if (!(b & 128)) return value; }
      fail('变长整数超过四字节');
    };
    const skip = (length) => { if (length > end - cursor) fail('事件负载截断'); cursor += length; };
    while (cursor < end) {
      if (++events > 500000) fail('事件数超过 500000 的预览上限');
      tick += vlq();
      if (!Number.isSafeInteger(tick)) fail('时间位置超限');
      let status = byte();
      if (status < 128) { if (!running) fail('缺少运行状态'); cursor--; status = running; }
      if (status === 0xff) {
        running = 0;
        const type = byte(), length = vlq();
        if (type === 0x2f) {
          if (length !== 0) fail('轨道结束事件长度无效');
          ended = true;
          // Bytes after end-of-track are not events and are ignored within the bounded chunk.
          cursor = end;
          break;
        }
        skip(length);
        continue;
      }
      if (status === 0xf0 || status === 0xf7) { running = 0; skip(vlq()); continue; }
      if (status >= 0xf0) fail('不支持的系统事件');
      running = status;
      const type = status >> 4, channel = status & 15;
      const a = byte(), b = type === 0xc || type === 0xd ? 0 : byte();
      if (a > 127 || b > 127) fail('通道事件数据无效');
      const key = channel * 128 + a;
      if (type === 0x9 && b > 0) {
        if (++noteCount > 30000) fail('音符数超过 30000 的预览上限');
        const note = { start: tick, end: tick, pitch: a, channel, track };
        notes.push(note);
        let queue = active.get(key);
        if (!queue) { queue = { notes: [], head: 0 }; active.set(key, queue); }
        queue.notes.push(note);
      } else if (type === 0x8 || (type === 0x9 && b === 0)) {
        const queue = active.get(key);
        if (queue && queue.head < queue.notes.length) {
          queue.notes[queue.head++].end = tick;
          if (queue.head === queue.notes.length) active.delete(key);
        }
      }
    }
    if (!ended) fail('缺少轨道结束事件');
    for (const queue of active.values()) {
      for (let index = queue.head; index < queue.notes.length; index++) { queue.notes[index].end = tick; unclosed++; }
    }
    maxTick = Math.max(maxTick, tick);
  }
  const timing = division & 0x8000 ? 'SMPTE tick' : `${division} tick/四分音符`;
  const info = `MIDI 格式 ${format} · ${trackCount} 轨 · ${noteCount} 音符 · ${timing} · 横轴 0–${maxTick} tick，纵轴 MIDI 音高 127–0；颜色区分通道。${format === 2 ? '各轨为独立序列，按各自起点叠加。' : ''}仅音符事件图，不合成声音或模拟踏板。${unclosed ? `${unclosed} 个未闭合音符延伸到轨道末尾。` : ''}`;
  if (!notes.length) return { kind: 'text', text: info + '\n没有 Note On 音符事件。', info };
  const width = 1024, height = 512, rgba = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const p = (y * width + x) * 4, shade = y % 4 === 0 || x % 128 === 0 ? 222 : 246;
    rgba[p] = shade; rgba[p + 1] = shade + 2; rgba[p + 2] = Math.min(255, shade + 5); rgba[p + 3] = 255;
  }
  for (const note of notes) {
    const left = Math.min(width - 1, Math.floor(note.start / Math.max(1, maxTick) * width));
    const right = Math.min(width, Math.max(left + 1, Math.ceil(note.end / Math.max(1, maxTick) * width)));
    const top = (127 - note.pitch) * 4;
    for (let y = top; y < top + 3; y++) for (let x = left; x < right; x++) {
      const p = (y * width + x) * 4;
      rgba[p] = 40 + note.channel * 11; rgba[p + 1] = 90 + (note.channel * 37) % 130; rgba[p + 2] = 210 - note.channel * 7;
    }
  }
  return { kind: 'image', mime: 'image/png', base64: PNG.sync.write({ width, height, data: rgba }).toString('base64'), width, height, info };
}

module.exports = { makeMidiPreview };
