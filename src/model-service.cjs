'use strict';

// Conversion runs in the existing worker; the UI receives opaque source/artifact IDs only.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const codec = require('./dimg-encode.cjs');
const FORMATS = new Set(['.glb', '.gltf', '.fbx', '.obj', '.blend', '.stl', '.ply']);
const MAX_BYTES = 64 * 1024 * 1024;
const defaults = Object.freeze({ width: 256, height: 256, scale: 1, directions: 5, framesPerDirection: 8,
  startFrame: 1, endFrame: 24, animation: '', azimuth: 0, elevation: 30,
  rotationX: 0, rotationY: 0, rotationZ: 0, modelScale: 1, offsetX: 0, offsetY: 0,
  orthoHeight: 0, lightEnergy: 1000 });

function number(value, name, min, max, integer = false) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) {
    throw new Error(`${name} 必须是 ${min}–${max} 范围内的${integer ? '整数' : '数值'}`);
  }
  return value;
}
function settingsOf(input) {
  const s = { ...defaults };
  for (const key of Object.keys(s)) if (input?.[key] !== undefined) s[key] = input[key];
  for (const key of ['width', 'height']) number(s[key], key, 8, 2048, true);
  if (![1, 2, 4].includes(s.scale)) throw new Error('素材倍率只支持 1×、2×、4×');
  number(s.directions, '方向数', 1, 16, true);
  number(s.framesPerDirection, '每方向帧数', 1, 128, true);
  for (const key of ['startFrame', 'endFrame']) number(s[key], key, -100000, 100000, true);
  if (s.endFrame < s.startFrame) throw new Error('结束帧不能早于起始帧');
  for (const key of ['azimuth', 'rotationX', 'rotationY', 'rotationZ']) number(s[key], key, -360, 360);
  number(s.elevation, '俯视角', 1, 89);
  number(s.modelScale, '模型缩放', 0.05, 10);
  for (const key of ['offsetX', 'offsetY']) number(s[key], key, -2048, 2048);
  number(s.orthoHeight, '相机视野高度', 0, 100000);
  number(s.lightEnergy, '灯光强度', 0, 100000);
  if (typeof s.animation !== 'string' || s.animation.length > 512) throw new Error('动画名称无效');
  return s;
}
function stamp(stat) { return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':'); }
async function sourceStat(file) {
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('模型必须是普通文件');
  if (stat.size > 512 * 1024 * 1024) throw new Error('模型文件超过 512 MiB 上限');
  return stat;
}
function safeName(value) { return path.basename(value, path.extname(value)).replace(/[^\p{L}\p{N}_.-]/gu, '_').slice(0, 80) || 'model'; }

class ModelService {
  constructor() {
    this.sources = new Map();
    this.artifacts = new Map();
    this.executable = '';
    this.controller = null;
    this.root = null;
    this.bytes = 0;
  }
  async workspace() {
    if (!this.root) {
      this.root = await fs.mkdtemp(path.join(os.tmpdir(), 'fantasy-model-'));
      // Blender cannot open a script inside app.asar; materialize our packaged script privately.
      await fs.copyFile(path.join(__dirname, 'model-render.py'), path.join(this.root, 'model-render.py'));
    }
    return this.root;
  }
  async configure(executable) {
    if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw new Error('请选择 Blender 可执行文件');
    if (executable.endsWith('.app')) executable = path.join(executable, 'Contents', 'MacOS', 'Blender');
    const stat = await fs.stat(executable);
    if (!stat.isFile()) throw new Error('所选位置不是 Blender 可执行文件');
    this.executable = executable;
    return { blender: executable };
  }
  async status() {
    if (!this.executable) {
      const candidates = process.platform === 'darwin' ? ['/Applications/Blender.app/Contents/MacOS/Blender']
        : process.platform === 'win32' ? [] : ['/usr/bin/blender', '/usr/local/bin/blender', '/snap/bin/blender'];
      for (const candidate of candidates) {
        try { await this.configure(candidate); break; } catch (_) { /* Optional local installation. */ }
      }
    }
    return { blender: this.executable, defaults, formats: [...FORMATS].map(s => s.slice(1)) };
  }
  async addSources(paths) {
    if (!Array.isArray(paths) || paths.length > 64 || this.sources.size + paths.length > 64) throw new Error('每个转换会话最多 64 个模型');
    const added = [];
    for (const selected of paths) {
      if (!FORMATS.has(path.extname(selected).toLowerCase())) throw new Error(`不支持的模型格式：${path.basename(selected)}`);
      await sourceStat(selected);
      const file = await fs.realpath(selected);
      const existing = [...this.sources.values()].find(item => item.path === file);
      if (existing) { added.push({ id: existing.id, name: existing.name }); continue; }
      const source = { id: crypto.randomUUID(), name: path.basename(file), path: file };
      this.sources.set(source.id, source);
      added.push({ id: source.id, name: source.name });
    }
    return added;
  }
  getSource(id) {
    const source = this.sources.get(id);
    if (!source) throw new Error('模型来源已失效，请重新添加');
    return source;
  }
  cancel() { this.controller?.abort(); }
  async run(manifest, progress, signal) {
    await this.status();
    if (!this.executable) throw new Error('未找到 Blender。请安装 Blender 4.2 或更新版本，然后通过“3D → 选择 Blender…”指定程序');
    const root = await this.workspace();
    const input = path.join(manifest.output, 'job.json');
    await fs.writeFile(input, JSON.stringify(manifest), { flag: 'wx', mode: 0o600 });
    if (signal?.aborted) throw new Error('转换已取消');
    await new Promise((resolve, reject) => {
      const child = spawn(this.executable, ['--background', '--factory-startup', '--disable-autoexec', '--python-exit-code', '1',
        '--python', path.join(root, 'model-render.py'), '--', input], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
      let tail = '';
      let progressLine = '';
      let killTimer;
      let timedOut = false;
      const stop = () => {
        child.kill('SIGTERM');
        killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
        killTimer.unref();
      };
      const timeout = setTimeout(() => { timedOut = true; stop(); }, 20 * 60 * 1000);
      timeout.unref();
      signal?.addEventListener('abort', stop, { once: true });
      const append = data => {
        tail = (tail + data.toString()).slice(-6000);
        progressLine += data.toString();
        const lines = progressLine.split('\n');
        progressLine = lines.pop().slice(-8192);
        for (const line of lines.filter(line => line.startsWith('FANTASY_PROGRESS '))) {
          try { progress?.(JSON.parse(line.slice(17))); } catch (_) { /* Blender also writes unrelated log lines. */ }
        }
      };
      child.stdout.on('data', append);
      child.stderr.on('data', data => { tail = (tail + data.toString()).slice(-6000); });
      const cleanup = () => { clearTimeout(timeout); clearTimeout(killTimer); signal?.removeEventListener('abort', stop); };
      child.once('error', error => { cleanup(); reject(new Error(`无法启动 Blender：${error.message}`)); });
      child.once('close', code => {
        cleanup();
        if (signal?.aborted) reject(new Error('转换已取消'));
        else if (timedOut) reject(new Error('单个模型转换超过 20 分钟，已终止'));
        else if (code !== 0) reject(new Error(`Blender 转换失败（${code}）：${tail}`));
        else resolve();
      });
    });
    const resultPath = path.join(manifest.output, 'result.json');
    const stat = await fs.lstat(resultPath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) throw new Error('转换结果清单无效');
    return JSON.parse(await fs.readFile(resultPath, 'utf8'));
  }
  async inspect(sourceId, progress) {
    const source = this.getSource(sourceId);
    const directory = await fs.mkdtemp(path.join(await this.workspace(), 'inspect-'));
    this.controller = new AbortController();
    try {
      await sourceStat(source.path);
      return await this.run({ source: source.path, output: directory, mode: 'inspect', settings: defaults }, progress, this.controller.signal);
    } finally { this.controller = null; await fs.rm(directory, { recursive: true, force: true }); }
  }
  async prepareEdit(sourceId, destination, progress) {
    const source = this.getSource(sourceId);
    if (this.sources.size >= 64) throw new Error('会话最多 64 个模型，请先移除一个模型');
    try { await fs.lstat(destination); throw new Error('工作副本路径已存在，请选择新文件名'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.extname(destination).toLowerCase() !== '.blend') throw new Error('工作副本必须保存为 .blend');
    const directory = await fs.mkdtemp(path.join(await this.workspace(), 'edit-'));
    this.controller = new AbortController();
    try {
      await sourceStat(source.path);
      await this.run({ source: source.path, output: directory, mode: 'edit', settings: defaults }, progress, this.controller.signal);
      if (this.controller.signal.aborted) throw new Error('转换已取消');
      const workspace = path.join(directory, 'workspace.blend');
      const stat = await fs.lstat(workspace);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024 * 1024) throw new Error('Blender 工作副本无效或超过 512 MiB');
      await fs.copyFile(workspace, destination, 1);
      const [added] = await this.addSources([destination]);
      return { source: added, path: destination, blender: this.executable };
    } finally { this.controller = null; await fs.rm(directory, { recursive: true, force: true }); }
  }
  async removeSource(sourceId) {
    for (const artifact of [...this.artifacts.values()]) if (artifact.sourceId === sourceId) await this.discard(artifact.id);
    this.sources.delete(sourceId);
  }
  async render(job, template, projectKey, progress) {
    const source = this.getSource(job.sourceId);
    // Template geometry is authoritative; irrelevant editable canvas limits must not reject small parts.
    const settings = settingsOf(template ? { ...job.settings, width: 256, height: 256, directions: 1, framesPerDirection: 1 } : job.settings);
    let description;
    if (template) {
      description = codec.describeTemplate(template.buffer, settings.scale, job.role || 'body');
      settings.directions = description.directions;
      settings.framesPerDirection = description.framesPerDirection;
      settings.width = Math.max(1, ...description.frames.map(frame => Math.ceil(frame.width / settings.scale)));
      settings.height = Math.max(1, ...description.frames.map(frame => Math.ceil(frame.height / settings.scale)));
    } else {
      const width = settings.width * settings.scale;
      const height = settings.height * settings.scale;
      description = { directions: settings.directions, framesPerDirection: settings.framesPerDirection, scale: settings.scale,
        frames: Array.from({ length: settings.directions * settings.framesPerDirection }, (_, index) => ({
          index, width, height, pivotX: Math.round(settings.width / 2) * settings.scale,
          pivotY: Math.round(settings.height * 0.85) * settings.scale, empty: false,
        })) };
    }
    if (!description.frames.some(frame => !frame.empty)) throw new Error('目标资源只有空帧，无法替换可见模型');
    if (description.frames.length > 4096) throw new Error('总帧数超过 4096 上限');
    let planeBytes = 0;
    for (const f of description.frames) {
      if (f.empty) continue;
      number(f.width, '帧宽度', 1, 4096, true); number(f.height, '帧高度', 1, 4096, true);
      planeBytes += f.width * f.height * 4;
    }
    if (planeBytes > MAX_BYTES - 1024 * 1024) throw new Error('输出像素超过单资源 63 MiB 预算，请减少尺寸、倍率或帧数');
    const previewIndex = job.previewIndex;
    if (previewIndex !== undefined) number(previewIndex, '预览帧', 0, description.frames.length - 1, true);
    const before = stamp(await sourceStat(source.path));
    const directory = await fs.mkdtemp(path.join(await this.workspace(), 'render-'));
    let keep = false;
    this.controller = new AbortController();
    try {
      const result = await this.run({ source: source.path, output: directory, mode: 'render', settings,
        frames: description.frames, ...(previewIndex !== undefined ? { previewIndex } : {}) }, progress, this.controller.signal);
      if (before !== stamp(await sourceStat(source.path))) throw new Error('转换期间模型源文件发生变化，请重新转换');
      if (this.controller.signal.aborted) throw new Error('转换已取消');
      const indices = previewIndex === undefined ? description.frames.map((_, i) => i) : [previewIndex];
      let bytes = 0;
      const pngs = [];
      for (const index of indices) {
        const frame = description.frames[index];
        if (frame.empty) { pngs.push(null); continue; }
        const file = path.join(directory, `f${String(index).padStart(5, '0')}.png`);
        const stat = await fs.lstat(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) throw new Error(`第 ${index + 1} 帧输出无效`);
        bytes += stat.size;
        if (bytes > MAX_BYTES) throw new Error('PNG 序列超过 64 MiB 上限');
        const png = await fs.readFile(file);
        // Read dimensions before decompression; never allocate for an unbounded PNG header.
        if (png.length < 33 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])) ||
            png.readUInt32BE(16) !== frame.width || png.readUInt32BE(20) !== frame.height) throw new Error(`第 ${index + 1} 帧尺寸与转换计划不一致`);
        pngs.push(png);
      }
      let encoded;
      if (previewIndex === undefined) {
        encoded = template ? codec.replaceFrames(template.buffer, pngs, settings.scale)
          : codec.createSprite(pngs, { width: settings.width, height: settings.height,
            scale: settings.scale, directions: settings.directions, framesPerDirection: settings.framesPerDirection,
            pivotX: Math.round(settings.width / 2), pivotY: Math.round(settings.height * 0.85) });
        if (encoded.length > MAX_BYTES) throw new Error('编码资源超过 64 MiB 上限');
        await fs.writeFile(path.join(directory, 'sprite.gsn'), encoded, { flag: 'wx' });
        bytes += encoded.length;
      }
      if (this.bytes + bytes > 512 * 1024 * 1024 || this.artifacts.size >= 64) throw new Error('转换缓存已满，请移除已完成结果后继续');
      const id = crypto.randomUUID();
      const artifact = { id, directory, bytes, sourceId: source.id, sourceName: source.name, settings, description, indices,
        previewOnly: previewIndex !== undefined, projectKey, targetId: template?.id ?? null, targetName: template?.name ?? '',
        expectedHash: template?.sha256 ?? '', warnings: Array.isArray(result.warnings) ? result.warnings.map(String).slice(0, 100) : [] };
      this.artifacts.set(id, artifact); this.bytes += bytes; keep = true;
      return { id, sourceId: source.id, settings, frames: description.frames.length,
        directions: description.directions, framesPerDirection: description.framesPerDirection,
        targetId: artifact.targetId, targetName: artifact.targetName, previewOnly: artifact.previewOnly,
        previewIndex: previewIndex ?? description.frames.findIndex(f => !f.empty), warnings: artifact.warnings };
    } finally {
      this.controller = null;
      if (!keep) await fs.rm(directory, { recursive: true, force: true });
    }
  }
  artifact(id) {
    const artifact = this.artifacts.get(id);
    if (!artifact) throw new Error('转换结果已失效，请重新转换');
    return artifact;
  }
  async frame(id, index) {
    const artifact = this.artifact(id);
    if (!artifact.indices.includes(index)) throw new Error('该帧尚未渲染');
    const f = artifact.description.frames[index];
    if (f.empty) return { empty: true, index };
    const data = await fs.readFile(path.join(artifact.directory, `f${String(index).padStart(5, '0')}.png`));
    return { index, width: f.width, height: f.height, base64: data.toString('base64') };
  }
  async export(ids, directory) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 64) throw new Error('请选择转换结果');
    const base = await fs.realpath(directory);
    const stat = await fs.stat(base);
    if (!stat.isDirectory()) throw new Error('导出位置必须是目录');
    const results = [];
    for (const id of new Set(ids)) {
      const a = this.artifact(id);
      if (a.previewOnly) throw new Error('单帧预览不能作为完整素材导出');
      // A fresh private subdirectory prevents overwrites, collisions and existing symlink traversal.
      const dest = await fs.mkdtemp(path.join(base, `${safeName(a.sourceName)}-`));
      try {
        await fs.copyFile(path.join(a.directory, 'sprite.gsn'), path.join(dest, 'sprite.gsn'), 1);
        for (const index of a.indices) {
          if (a.description.frames[index].empty) continue;
          const name = `f${String(index).padStart(5, '0')}.png`;
          await fs.copyFile(path.join(a.directory, name), path.join(dest, name), 1);
        }
        await fs.writeFile(path.join(dest, 'conversion.json'), JSON.stringify({ version: 1, source: a.sourceName,
          settings: a.settings, target: a.targetName, frames: a.description.frames, warnings: a.warnings }, null, 2), { flag: 'wx' });
        results.push({ id, directory: dest, ok: true });
      } catch (error) {
        await fs.rm(dest, { recursive: true, force: true });
        results.push({ id, ok: false, error: error.message });
      }
    }
    return results;
  }
  async discard(id) {
    const a = this.artifacts.get(id);
    if (!a) return;
    await fs.rm(a.directory, { recursive: true, force: true });
    this.artifacts.delete(id); this.bytes -= a.bytes;
  }
  async dispose() {
    this.cancel();
    if (this.root) await fs.rm(this.root, { recursive: true, force: true });
    this.root = null; this.sources.clear(); this.artifacts.clear(); this.bytes = 0;
  }
}
module.exports = { ModelService, settingsOf };
