/**
 * Web 管理面板（daemon/ui.js）的静态检查。
 *
 * 这个文件整个是一个模板字符串，里面塞着完整的 HTML + JS ——
 * 意味着**语法错误编辑器不会报，运行时才炸**，而且炸在浏览器里，
 * 服务端一切正常。同一个坑踩过两次：写在 confirm 文案里的 `\n`
 * 被模板字符串解析成真实换行，把 JS 字符串截断，整个面板白屏。
 *
 * 所以这里做的第一件事就是把 script 块拿出来编译一遍。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderUi } from '../src/daemon/ui.js';

const html = renderUi();
const script = /<script>([\s\S]*)<\/script>/.exec(html);

test('面板的内联脚本语法合法', () => {
  assert.ok(script, '找不到 <script> 块');
  // new Function 会真的编译一遍。模板字符串里的 `\n` 没转义就会在这里炸。
  //
  // 只做这一层、不再自己数引号定位到具体行：试过，正则字面量里的 `"`
  // （比如 esc 里的 /[&<>"]/g）会被当成字符串引号，误报比帮助多。
  // 要判准得上 JS tokenizer，不值当 —— 编译错误本身就带行号。
  assert.doesNotThrow(() => new Function(script[1]), '内联脚本编译失败 —— 面板会白屏');
});

test('不引用任何外部资源 —— 面板要能离线用', () => {
  assert.doesNotMatch(html, /<script[^>]+src=/i, '不该有外链脚本');
  assert.doesNotMatch(html, /<link[^>]+href=["']https?:/i, '不该有外链样式');
  assert.doesNotMatch(html, /@import\s+url\(["']?https?:/i, '不该 @import 远程样式');
  // 字体也不能连 CDN
  assert.doesNotMatch(html, /fonts\.googleapis|fonts\.gstatic|cdn\./i, '不该连 CDN');
});

test('同步管理的控件都在', () => {
  for (const id of ['syncTarget', 'btnSync', 'btnUnsync', 'btnSyncAll', 'btnPurge', 'selAll']) {
    assert.ok(html.includes(`id="${id}"`), `少了控件 ${id}`);
  }
  // 整批接入和清理残骸默认藏着，满足条件才显示
  assert.match(html, /id="btnSyncAll"[^>]*hidden/, 'btnSyncAll 该默认隐藏');
  assert.match(html, /id="btnPurge"[^>]*hidden/, 'btnPurge 该默认隐藏');
});

test('token 走 URL fragment，不进查询串', () => {
  // fragment 不发给服务端、不进 referer、不进访问日志
  assert.match(script[1], /location\.hash/, 'token 该从 fragment 读');
  assert.match(script[1], /sessionStorage/, 'token 该存 sessionStorage');
  assert.match(script[1], /history\.replaceState/, '读完要把地址栏擦干净');
  assert.doesNotMatch(script[1], /location\.search[^;]*token/i, 'token 不该走查询串');
});

test('会话内容一律转义后再插进 DOM', () => {
  assert.match(script[1], /function esc\(/, '缺 esc 函数');
  // innerHTML 拼接里出现裸的 s.title / m.text 就是注入口子
  const risky = /innerHTML[^;]*\+\s*(s|r|m|x)\.(title|text|cwd|id)\b/.exec(script[1]);
  assert.equal(risky, null, `会话字段没转义就拼进 innerHTML：${risky && risky[0]}`);
});
