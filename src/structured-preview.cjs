'use strict';

const { parseSchema } = require('./table-preview.cjs');

const PAGE_SIZE = 64;
const TYPE_NAMES = new Map([
  [1, '结构引用'], [2, 'int8'], [3, 'uint8'], [4, 'int16'],
  [5, 'uint16'], [6, 'int32'], [7, 'uint32'], [18, 'char'],
]);

// Reuse the same UDg descriptor reader that resolves the BIN table schema.
// Display declared types and offsets; do not infer types from row values.
function makeStructuredPreview(buffer, name, { page = 0 } = {}) {
  const basename = String(name || '').replace(/\\/g, '/').split('/').pop().toLowerCase();
  if (basename !== 'ov_res.bin') return null;
  if (!Number.isSafeInteger(page) || page < 0) throw new Error('结构定义页码无效');
  const { structures } = parseSchema(buffer);
  const rowCount = structures.reduce((total, structure) => total + Math.max(1, structure.fields.length), 0);
  const pageCount = Math.max(1, Math.ceil(rowCount / PAGE_SIZE));
  if (page >= pageCount) throw new Error(`结构定义页码越界，共 ${pageCount} 页`);
  const first = page * PAGE_SIZE;
  const end = first + PAGE_SIZE;
  const lines = ['结构\t记录长度\t字段\t类型\t偏移\t长度\t元素数\t元素长度\t说明'];
  let position = 0;
  for (const structure of structures) {
    const count = Math.max(1, structure.fields.length);
    if (position + count > first && position < end) {
      for (let index = Math.max(0, first - position); index < Math.min(count, end - position); index += 1) {
        const field = structure.fields[index];
        if (!field) {
          lines.push(`${structure.name}\t${structure.recordSize}\t（无字段）`);
          continue;
        }
        const declaredType = TYPE_NAMES.get(field.typeCode) || `类型码 ${field.typeCode}`;
        const description = field.description.replace(/[\r\n\t]/g, ' ');
        lines.push([structure.name, structure.recordSize, field.name, declaredType,
          field.offset, field.size, field.count, field.elem, description].join('\t'));
      }
    }
    position += count;
    if (position >= end) break;
  }
  return {
    kind: 'text', text: lines.join('\n'), page, pageCount,
    info: `UDg 结构定义 · ${structures.length} 个结构 · ${rowCount} 条字段记录`,
  };
}

module.exports = { makeStructuredPreview };
