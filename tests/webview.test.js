/**
 * 侧边栏 webview 的测试。
 *
 * 语法错误或转义漏洞在 IDE 里几乎看不出来（表现只是「侧边栏空白」或者更糟：
 * 会话内容里的 HTML 被当代码执行），所以这里把内联脚本抽出来直接验。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { renderHtml } = require('../vscode-ext/webview.js');

const html = renderHtml();
const script = html.match(/<script nonce="[^"]+">([\s\S]*?)<\/script>/)[1];

/** 在一个假 DOM 里跑 webview 脚本，把它内部的函数捞出来 */
function loadScript() {
  const noop = () => {};
  const fakeEl = {
    addEventListener: noop,
    innerHTML: '',
    value: '',
    dataset: {},
    classList: { add: noop, remove: noop },
  };
  const ctx = {
    acquireVsCodeApi: () => ({ postMessage: noop }),
    document: {
      getElementById: () => fakeEl,
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: noop,
    },
    window: { addEventListener: noop },
    setTimeout: noop,
    clearTimeout: noop,
    console,
    Date,
    Math,
    String,
    Number,
    JSON,
  };
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(script, ctx);
  return ctx;
}

test('webview 脚本能在干净环境里跑起来（语法 + 顶层逻辑）', () => {
  assert.doesNotThrow(loadScript);
});

test('esc 转义 HTML —— 会话内容里的标签绝不能被当代码执行', () => {
  const ctx = loadScript();
  const evil = '<script>alert(1)</script>';
  const out = ctx.esc(evil);
  assert.ok(!out.includes('<script'), `没转义: ${out}`);
  assert.equal(out, '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(ctx.esc('a"b&c'), 'a&quot;b&amp;c');
  assert.equal(ctx.esc(null), '');
});

test('搜索片段先转义再上高亮标记，不能被注入', () => {
  const ctx = loadScript();
  // daemon 用 ⟦⟧ 包裹命中词，正因为它不会和 HTML 冲突
  assert.equal(ctx.snippet('前⟦命中⟧后'), '前<mark>命中</mark>后');
  const evil = ctx.snippet('<img src=x onerror=alert(1)>⟦词⟧');
  assert.ok(!evil.includes('<img'), `标签没转义: ${evil}`);
  assert.ok(evil.includes('<mark>词</mark>'), '高亮应该还在');
});

test('相对时间用中文且分档合理', () => {
  const ctx = loadScript();
  const ago = (ms) => ctx.rel(new Date(Date.now() - ms).toISOString());
  assert.equal(ago(10_000), '刚刚');
  assert.equal(ago(5 * 60_000), '5 分钟前');
  assert.equal(ago(3 * 3600_000), '3 小时前');
  assert.equal(ago(2 * 86400_000), '2 天前');
  assert.equal(ctx.rel(null), '');
});

test('HTML 里不引用任何外部资源（webview 的 CSP 会直接拦掉）', () => {
  assert.ok(!/(src|href)\s*=\s*["']https?:/.test(html), '不该有外链');
  assert.ok(/Content-Security-Policy/.test(html), '必须带 CSP');
  const cspNonce = html.match(/nonce-([a-z0-9]+)/)[1];
  const tagNonce = html.match(/<script nonce="([a-z0-9]+)"/)[1];
  assert.equal(cspNonce, tagNonce, 'CSP 里的 nonce 必须和 script 标签一致，否则脚本被拦、侧边栏空白');
});

test('侧边栏用 daemon 下发的 prefix，不自己维护映射表', () => {
  // 之前扩展里硬编码了一份 TAGS 映射，和 core 那份迟早不一致。
  // 现在每条会话自带 prefix 字段，扩展只管渲染。
  assert.ok(!/const TAGS\s*=/.test(html), '不该再有硬编码的工具→标签映射');
  assert.ok(/s\.prefix/.test(html), '应该用会话对象上的 prefix 字段');
  assert.ok(/\.t-codex \.tag/.test(html), '前缀要按工具染色');
});
