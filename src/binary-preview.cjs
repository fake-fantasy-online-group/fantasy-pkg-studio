'use strict';

const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const PAGE_BYTES = 4096;
const ROW_BYTES = 16;

function makeBinaryPreview(buffer, name, options = {}) {
  if (!Buffer.isBuffer(buffer)) throw new TypeError('binary preview requires a Buffer');
  if (buffer.length > MAX_INPUT_BYTES) throw new Error('二进制预览超过 64 MiB 上限');
  if (!/\.bin$/i.test(String(name ?? ''))) return null;
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw new Error('二进制预览分页参数无效');

  const page = options.page === undefined ? 0 : options.page;
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('二进制页码必须是非负安全整数');
  const pageCount = Math.max(1, Math.ceil(buffer.length / PAGE_BYTES));
  if (page >= pageCount) throw new Error(`二进制页码超出范围（共 ${pageCount} 页）`);

  const start = page * PAGE_BYTES;
  const end = Math.min(buffer.length, start + PAGE_BYTES);
  const shown = buffer.subarray(start, end);
  const lines = [];
  for (let row = 0; row < shown.length; row += ROW_BYTES) {
    const part = shown.subarray(row, row + ROW_BYTES);
    const hex = Array.from(part, (byte) => byte.toString(16).padStart(2, '0')).join(' ').padEnd(47, ' ');
    const ascii = Array.from(part, (byte) => byte >= 32 && byte <= 126 ? String.fromCharCode(byte) : '.').join('');
    const offset = start + row;
    lines.push(`${offset.toString(16).padStart(8, '0')}  ${hex}  ${ascii}`);
  }

  const range = buffer.length === 0 ? '空文件' : `字节 ${start}–${end - 1} / ${buffer.length}`;
  return {
    kind: 'hex',
    text: lines.length ? lines.join('\n') : '(空文件)',
    info: `原始二进制 · 字段尚未解释 · ${buffer.length} bytes · ${range}`,
    page,
    pageCount,
    totalBytes: buffer.length,
    pageSize: PAGE_BYTES,
  };
}

module.exports = { makeBinaryPreview, PAGE_BYTES, MAX_INPUT_BYTES };
