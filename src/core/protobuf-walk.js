/**
 * 无 schema 的 protobuf 遍历器。
 *
 * Antigravity 把会话正文存成 protobuf blob，但没有公开 `.proto`。
 * 好消息是 protobuf 的 wire format 本身是自描述的：每个字段都带
 * 「字段号 + wire type」，不需要 schema 就能把结构走一遍。
 * 我们要的只是里面的字符串，所以：
 *   - wire type 2（length-delimited）先试着当 UTF-8 文本解
 *   - 解出来不像文本就当嵌套 message 递归下去
 *
 * 这是启发式的，会有误判（把二进制当成文本、或反过来）。所以：
 *   1. 返回值带字段路径，调用方可以按路径挑，而不是全盘接受
 *   2. 出错一律吞掉返回已解出的部分 —— Antigravity 改版时我们要的是
 *      「这家索引质量下降」，不是「整个 xsess 崩了」
 */

/** @typedef {{path:number[], text:string}} PbString */

const MIN_TEXT_LEN = 2;

/**
 * 走一遍 buffer，收集所有看起来是文本的 length-delimited 字段。
 *
 * @param {Buffer|Uint8Array} buf
 * @param {{maxDepth?:number, maxStrings?:number, minLen?:number}} [opts]
 * @returns {PbString[]}
 */
export function extractStrings(buf, opts = {}) {
  const { maxDepth = 12, maxStrings = 5000, minLen = MIN_TEXT_LEN } = opts;
  /** @type {PbString[]} */
  const out = [];
  try {
    walk(Buffer.from(buf), [], 0, out, maxDepth, maxStrings, minLen);
  } catch {
    // 半路解析失败很正常（字段其实是二进制却被当成了 message），
    // 已经收到的部分照样有用
  }
  return out;
}

function walk(buf, path, depth, out, maxDepth, maxStrings, minLen) {
  let i = 0;
  const n = buf.length;
  while (i < n) {
    if (out.length >= maxStrings) return;

    const keyRes = readVarint(buf, i);
    if (!keyRes) return;
    i = keyRes.next;
    const key = keyRes.value;
    const fieldNo = Number(key >> 3n);
    const wireType = Number(key & 7n);
    if (fieldNo === 0) return; // 字段号 0 非法 —— 说明我们把二进制当 message 解了

    switch (wireType) {
      case 0: {
        const v = readVarint(buf, i);
        if (!v) return;
        i = v.next;
        break;
      }
      case 1:
        i += 8;
        break;
      case 5:
        i += 4;
        break;
      case 2: {
        const lenRes = readVarint(buf, i);
        if (!lenRes) return;
        const len = Number(lenRes.value);
        i = lenRes.next;
        if (len < 0 || i + len > n) return;
        const sub = buf.subarray(i, i + len);
        i += len;

        const nextPath = path.length < maxDepth ? [...path, fieldNo] : path;
        const text = asText(sub, minLen);
        if (text !== null) {
          out.push({ path: nextPath, text });
        } else if (depth < maxDepth && len > 1) {
          walk(sub, nextPath, depth + 1, out, maxDepth, maxStrings, minLen);
        }
        break;
      }
      default:
        return; // wire type 3/4（已废弃的 group）或垃圾数据，停在这里
    }
  }
}

/** protobuf varint（最多 10 字节） */
function readVarint(buf, start) {
  let value = 0n;
  let shift = 0n;
  let i = start;
  while (i < buf.length) {
    const b = buf[i++];
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value, next: i };
    shift += 7n;
    if (shift > 63n) return null;
  }
  return null;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });

/**
 * 判断一段字节是不是「有意义的文本」。
 * 严格 UTF-8 解码（fatal:true）已经挡掉大部分二进制；
 * 再要求可打印字符占比高，挡掉那些碰巧是合法 UTF-8 的控制字节序列。
 */
function asText(bytes, minLen) {
  if (bytes.length < minLen) return null;

  // 嵌套 message 有时碰巧是合法 UTF-8，会被当成文本，解出来长这样：
  //   "\n;这段中文其实是里层字段的内容"
  // 开头那两个字节其实是 protobuf 的 tag + 长度。识别特征很硬：
  // 首字节是控制字符，次字节正好等于「剩余长度」。命中就当成嵌套消息递归下去，
  // 这样拿到的是里层那条干净的字符串。
  if (bytes.length > 2 && bytes[0] < 0x20 && bytes[1] === bytes.length - 2) return null;

  let s;
  try {
    s = utf8.decode(bytes);
  } catch {
    return null;
  }
  if (!s) return null;
  let printable = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 9 || cp === 10 || cp === 13 || cp >= 32) printable++;
  }
  return printable / [...s].length > 0.9 ? s : null;
}

// ---------------------------------------------------------------- 降噪

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXID_RE = /^[0-9a-fA-F-]{16,}$/;
const TOKENISH_RE = /^[A-Za-z0-9_-]{16,}$/; // 随机 ID、base64url 片段
const NOISE_RE = /^(sessionID-\d+|MODEL_[A-Z0-9_]+|[A-Z][A-Z0-9_]{6,})$/;

/** 这串是 ID / 枚举名 / 随机 token 这类噪音吗？ */
export function isNoise(s) {
  const t = s.trim();
  if (!t) return true;
  if (UUID_RE.test(t)) return true;
  if (HEXID_RE.test(t)) return true;
  if (NOISE_RE.test(t)) return true;
  // 全 ASCII 且无空格无标点的长串，基本是 token 不是人话
  if (TOKENISH_RE.test(t) && !/[ .,:;!?]/.test(t)) return true;
  return false;
}

/**
 * 去重：protobuf 里同一段文本经常在多个字段重复出现
 * （一次是原文，一次包在 rich-text 结构里）。
 * 保留最长的那个版本，被它包含的短版本丢掉。
 */
export function dedupeStrings(strings) {
  const uniq = [...new Set(strings.map((s) => s.trim()).filter(Boolean))];
  uniq.sort((a, b) => b.length - a.length);
  /** @type {string[]} */
  const kept = [];
  for (const s of uniq) {
    if (!kept.some((k) => k.includes(s))) kept.push(s);
  }
  // 按在原数组里的首次出现顺序还原，保持对话的时间感
  const order = new Map();
  strings.forEach((s, i) => {
    const t = s.trim();
    if (!order.has(t)) order.set(t, i);
  });
  return kept.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
}
