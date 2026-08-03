/**
 * protobuf 的「模板替换」写入原语。
 *
 * 往 Antigravity 里写会话需要产出合法的 protobuf，但它没有公开 `.proto`。
 * 从零构造要求猜对每个字段的编号和类型 —— 猜错就是静默损坏。
 *
 * 所以不猜：拿一条**真实存在**的记录当模板，只替换我们确切知道含义的那几个
 * 字段（ID、标题、工作区路径），其余全部按原始字节搬过去。
 * 不认识的字段照样是合法的、Antigravity 认识的值。
 *
 * 关键性质（这是 protobuf 的定义，不是运气）：
 *   - 沿路径下降时只解析路径上的那些嵌套消息，其余一律当不透明字节
 *     → 不需要区分「子消息」和「碰巧像文本的二进制」，读取那边的启发式在这里完全用不上
 *   - 改了字符串长度后，只有路径上各层的长度前缀要重算，兄弟字段字节不变
 */

/** 读一个 varint */
function readVarint(buf, i) {
  let value = 0n;
  let shift = 0n;
  while (i < buf.length) {
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

/** 写一个 varint */
export function writeVarint(n) {
  const out = [];
  let v = BigInt(n);
  while (v > 0x7fn) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

/** 拼一个 length-delimited 字段：tag + 长度 + 内容 */
export function lenDelim(field, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  return Buffer.concat([writeVarint((field << 3) | 2), writeVarint(body.length), body]);
}

/**
 * 把一个消息切成顶层字段列表。只切一层，每个字段的内容保持原始字节。
 * @returns {{field:number, wireType:number, tagStart:number, valueStart:number, valueEnd:number}[]}
 */
export function splitFields(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const tagStart = i;
    const k = readVarint(buf, i);
    if (!k) break;
    i = k.next;
    const field = Number(k.value >> 3n);
    const wireType = Number(k.value & 7n);
    let valueStart = i;
    let valueEnd;
    switch (wireType) {
      case 0: {
        const v = readVarint(buf, i);
        if (!v) return out;
        valueEnd = v.next;
        break;
      }
      case 1:
        valueEnd = i + 8;
        break;
      case 5:
        valueEnd = i + 4;
        break;
      case 2: {
        const l = readVarint(buf, i);
        if (!l) return out;
        valueStart = l.next;
        valueEnd = valueStart + Number(l.value);
        break;
      }
      default:
        return out; // group（已废弃）或垃圾数据，停下
    }
    if (valueEnd > buf.length) return out;
    out.push({ field, wireType, tagStart, valueStart, valueEnd });
    i = valueEnd;
  }
  return out;
}

/**
 * 沿字段路径替换一个 length-delimited 字段的内容。
 *
 * @param {Buffer} buf   原始消息
 * @param {number[]} path 字段路径，如 [1, 2, 1]
 * @param {Buffer|string} value 新内容
 * @param {{occurrence?:number}} [opts] 同名字段出现多次时取第几个（默认第 0 个）
 * @returns {Buffer} 新消息；路径不存在时原样返回
 */
export function replaceAt(buf, path, value, opts = {}) {
  const { occurrence = 0 } = opts;
  if (!path.length) return Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');

  const [head, ...rest] = path;
  const fields = splitFields(buf);
  let seen = -1;
  let target = null;
  for (const f of fields) {
    if (f.field !== head || f.wireType !== 2) continue;
    if (++seen === occurrence) {
      target = f;
      break;
    }
  }
  if (!target) return buf; // 路径不存在，不改

  const inner = buf.subarray(target.valueStart, target.valueEnd);
  const newInner = rest.length
    ? replaceAt(inner, rest, value, opts)
    : Buffer.isBuffer(value)
      ? value
      : Buffer.from(String(value), 'utf8');

  // 只重算这一层的长度前缀；兄弟字段的字节原样保留
  return Buffer.concat([
    buf.subarray(0, target.tagStart),
    writeVarint((head << 3) | 2),
    writeVarint(newInner.length),
    newInner,
    buf.subarray(target.valueEnd),
  ]);
}

/**
 * 沿路径取出一个字段的原始字节。
 * @returns {Buffer|null}
 */
export function valueAt(buf, path, opts = {}) {
  const { occurrence = 0 } = opts;
  if (!path.length) return buf;
  const [head, ...rest] = path;
  const fields = splitFields(buf);
  let seen = -1;
  for (const f of fields) {
    if (f.field !== head || f.wireType !== 2) continue;
    if (++seen === occurrence) {
      const inner = buf.subarray(f.valueStart, f.valueEnd);
      return rest.length ? valueAt(inner, rest, opts) : inner;
    }
  }
  return null;
}

/** 沿路径取字符串 */
export function stringAt(buf, path, opts = {}) {
  const v = valueAt(buf, path, opts);
  return v ? v.toString('utf8') : null;
}

/**
 * 把一个 UUID 在整段字节里全部替换成另一个。
 *
 * 会话记录里同一个 ID 会在好几处出现（有的在我们认识的路径上，有的在不认识的
 * 嵌套结构深处）。UUID 是定长 36 字节 ASCII，替换前后长度不变，
 * 所以可以直接按字节替换，不用重算任何长度前缀 —— 这是安全的。
 *
 * @param {Buffer} buf
 * @param {string} from 36 字符的 UUID
 * @param {string} to   36 字符的 UUID
 */
export function replaceUuidBytes(buf, from, to) {
  if (from.length !== to.length) {
    throw new Error(`按字节替换要求等长：${from.length} vs ${to.length}`);
  }
  const a = Buffer.from(from, 'utf8');
  const b = Buffer.from(to, 'utf8');
  // 用 alloc+set 而不是 Buffer.from(buf) 复制：两者都是拷贝，
  // 但前者返回的 Buffer 泛型和 Buffer.concat 一致，省得调用方到处转类型
  const out = Buffer.alloc(buf.length);
  out.set(buf);
  let idx = 0;
  for (;;) {
    idx = out.indexOf(a, idx);
    if (idx === -1) break;
    b.copy(out, idx);
    idx += b.length;
  }
  return out;
}

/**
 * 顶层是 `repeated <字段N>` 的文件，追加一条记录。
 *
 * 这是整个直写方案安全的根源：protobuf 的 repeated 字段就是同一个 tag 重复出现，
 * 所以「新增一条」在字节层面等于「在文件末尾接一段」——
 * 已有内容一个字节都不用碰，也就不存在改坏的可能。
 */
export function appendRecord(fileBytes, field, recordBytes) {
  return Buffer.concat([fileBytes, lenDelim(field, recordBytes)]);
}
