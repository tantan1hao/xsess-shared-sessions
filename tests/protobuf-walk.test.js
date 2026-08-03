import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractStrings, isNoise, dedupeStrings } from '../src/core/protobuf-walk.js';

/**
 * 手搓一个 protobuf：字段号 field、wire type 2、内容 payload。
 * key 必须走 varint —— 字段号 ≥16 时 `(field<<3)|2` 就超过 0x7f 了，
 * 单字节写出去续读位是 1，解析器会把长度字节一起吞掉。
 */
function lenDelim(field, payload) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, 'utf8');
  return Buffer.concat([varint((field << 3) | 2), varint(body.length), body]);
}
function varint(n) {
  const out = [];
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80);
    n >>>= 7;
  }
  out.push(n);
  return Buffer.from(out);
}

test('extractStrings 抽出顶层字符串并记录字段路径', () => {
  const buf = lenDelim(19, '这是一段用来验证解析的中文测试文本');
  const out = extractStrings(buf);
  assert.equal(out.length, 1);
  assert.deepEqual(out[0].path, [19]);
  assert.equal(out[0].text, '这是一段用来验证解析的中文测试文本');
});

test('extractStrings 递归进嵌套 message，路径带层级', () => {
  const inner = lenDelim(2, '用户消息正文');
  const buf = lenDelim(19, inner);
  const out = extractStrings(buf);
  const hit = out.find((s) => s.text === '用户消息正文');
  assert.ok(hit, '应该解出内层文本');
  assert.deepEqual(hit.path, [19, 2], '路径应是 19.2');
});

test('嵌套 message 碰巧是合法 UTF-8 时不该被当成文本', () => {
  // 这就是 Antigravity 里那个真实的坑：外层解出来会带上 "\n;" 这样的帧字节
  const inner = lenDelim(1, '这是一段用来验证解析的中文测试文本');
  const buf = lenDelim(19, inner);
  const out = extractStrings(buf);
  for (const s of out) {
    assert.ok(
      !s.text.startsWith('\n'),
      `不该把嵌套 message 当文本返回，拿到了 ${JSON.stringify(s.text)}`,
    );
  }
  assert.ok(out.some((s) => s.text === '这是一段用来验证解析的中文测试文本'));
});

test('extractStrings 遇到垃圾字节不抛异常', () => {
  assert.doesNotThrow(() => extractStrings(Buffer.from([0xff, 0xff, 0xff, 0x00, 0x7f])));
  assert.doesNotThrow(() => extractStrings(Buffer.alloc(0)));
});

test('isNoise 识别 UUID / 枚举名 / 随机 token', () => {
  assert.ok(isNoise('3f2b91c4-77ae-4d10-9c3e-1a5b8de62047'));
  assert.ok(isNoise('MODEL_PLACEHOLDER_M71'));
  assert.ok(isNoise('0mJwapKtPNC9qtsPrPqOkAM'));
  assert.ok(!isNoise('这是一段用来验证解析的中文测试文本'));
  assert.ok(!isNoise('search_web'));
});

test('dedupeStrings 丢掉被更长版本包含的重复片段', () => {
  const out = dedupeStrings(['完整的一句话在这里', '完整的一句话', '另一句']);
  assert.deepEqual(out, ['完整的一句话在这里', '另一句']);
});
