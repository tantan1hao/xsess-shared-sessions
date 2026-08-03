# xsess —— 跨 AI IDE 的共享会话栏

把 **Claude Code / Codex / Antigravity（反重力）/ Cursor / Gemini CLI** 的会话历史索引到一处：
在任何一家里都能看到、搜到、并接续其他家的会话。

解决的是这个问题：你为了额度或手感在几家 AI 工具之间轮换，
但每家的会话历史都锁在自己的存储里 —— 在 Codex 里查了半天的东西，切到 Claude 得从头讲一遍。

---

## 三个入口，一份索引

| 入口 | 给谁用 | 怎么开 |
|---|---|---|
| **MCP 服务** | AI 自己 | Claude Code 里直接问「Codex 上周聊了什么」，它会自己去查 |
| **侧边栏** | 你 | Antigravity / Cursor / Trae / Kiro / VS Code 活动栏的「共享会话」 |
| **CLI** | 你 / 脚本 | `xsess list`、`xsess search`、`xsess show` |

三者共用同一个本地 SQLite 索引，不重复解析。

---

## 装起来

```bash
node bin/xsess.js scan
```

首次全量扫描的耗时取决于会话总量（几百个会话约 1 分钟），之后增量扫描通常在 100ms 以内。然后：

```bash
node bin/xsess.js mcp install --write
```

```bash
node bin/xsess.js ide install --write
```

两条命令默认都是**预览**，加 `--write` 才真的改配置，改前自动备份到 `~/.xsess/backups/`。
装完重启对应的 IDE / CLI 生效。撤销就是把 `install` 换成 `uninstall`。

---

## 常用命令

```bash
node bin/xsess.js list --tool codex -n 10
```

```bash
node bin/xsess.js search "上次那个方案"
```

```bash
node bin/xsess.js list --cwd
```

`--cwd` 不给值就是当前目录 —— 看这个项目在各家工具里的所有会话。

```bash
node bin/xsess.js handoff <会话ID> --to claude-code --write
```

把某个会话接续到别的工具，`--to` 支持 `claude-code` / `codex` / `antigravity`：

- `claude-code` → `claude --resume` 列表里直接出现
- `codex` → `codex resume` 列表里直接出现
- `antigravity` → 出现在它**原生的** Conversation History / Projects 面板里
  （需要先完全退出 Antigravity）

---

## 各家工具的支持情况

| 工具 | 存储 | 读 | 写回 |
|---|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | ✅ | ✅ 真·写回 |
| Codex | `~/.codex/sessions/**/rollout-*.jsonl` | ✅ | ✅ 真·写回 |
| Gemini CLI | `~/.gemini/tmp/*/chats/*.jsonl` | ✅ | — |
| Antigravity | `~/.gemini/antigravity/conversations/*.db`（SQLite + protobuf） | ✅ | ✅ 真·写回（进它原生的会话列表） |
| Cursor | `state.vscdb`（SQLite + JSON） | ✅ | 注入式接力 |
| Trae CN | 会话正文不在 vscdb（那里只有 UI 布局），疑似 Chromium LevelDB 或服务端 | ❌ | — |
| Kiro | 未找到本地会话正文（可能存在别处或服务端） | ❌ | — |

### 为什么写回分两级

**真·写回**（Claude Code / Codex / Antigravity）：xsess **只新建**，绝不修改任何已存在的
会话数据；创建过的文件记在 `~/.xsess/written.jsonl`，`xsess undo --write` 一键清掉。

Claude Code 和 Codex 是明文 JSONL，格式已完整逆向，生成新会话文件让 `--resume` 接上。

Antigravity 是**无 schema 的 protobuf**，一开始看着像不能碰。摸清结构后发现，
需要做的不是改写而是追加：会话索引 `agyhub_summaries_proto.pb` 的顶层是纯 `repeated 字段1`，
而 protobuf 的 repeated 就是同一个 tag 重复出现 —— 所以「新增一条会话」在字节层面
等于在文件尾接一段，已有内容一个字节都不用碰。正文则写进新建的 `conversations/<新uuid>.db`。

产出合法 protobuf 靠的也不是猜字段：拿一条**真实存在**的记录当模板，
只替换确切知道含义的字段（ID、标题、正文），其余字节原样搬过去。
模板优先挑同工作区的那条 —— Projects 面板按工作区 URI 分组，挑对模板就等于免费拿到正确分组。

写之前会检查 Antigravity 是否在运行（它把列表缓存在内存里，退出时会覆盖掉追加的内容），
并在生成的字节上自检「解析必须覆盖到文件末尾、已有字节必须零改动」，不通过就放弃写入。

**注入式接力**（Cursor）：**故意不直写**。`state.vscdb` 动辄几百 MB、
运行时开着 WAL 在写，并发写入等于拿全部历史赌一把。
替代方案在体验上等价：侧边栏点「接续到这里」→ 交接包落到工作区 `.xsess/` 并复制到剪贴板 →
在聊天框粘贴或 `@` 引用。

---

## 设计取舍

**零依赖、零构建。** 用 Node 22+ 内置的 `node:sqlite`，不引 `better-sqlite3`（省掉原生编译）；
核心是 ESM JavaScript + JSDoc 类型标注，配 `checkJs` 的 tsconfig ——
`npx tsc --noEmit` 一样有 TypeScript 的类型检查，但改完立刻能跑。
侧边栏扩展是纯 CommonJS JS，「拷进 extensions 目录」就是完整的安装过程，不需要 vsce。

**中文全文搜索用 FTS5 的 trigram 分词器。** 默认的 unicode61 不切中文，
「跨工具会话」会被当成一个词，搜「会话」就搜不到。代价是查询串要 ≥3 字符，
更短的自动降级成 LIKE。

**daemon 强制 token 鉴权。** 只绑 127.0.0.1 挡不住浏览器 ——
你打开的任意网页都能 `fetch('http://127.0.0.1:10180/api/sessions')`。
token 存在 `~/.xsess/daemon.json`（0600），跨站请求带不上 Authorization 头，只能拿到 401。

**Codex 的子代理会话默认折叠。** Codex 的 rollout 里有相当比例是 guardian 判定会话
（`thread_source: "subagent"`），正文是风险评估模板不是真对话。
不折叠的话会话栏会被它们淹掉，`--all` 可以看。

---

## 数据都在哪

```
~/.xsess/
├── index.db          SQLite 索引 + FTS5
├── daemon.json       daemon 端口和 token（0600）
├── written.jsonl     xsess 创建过的会话文件清单（undo 的依据）
├── handoff/          生成过的交接包
└── backups/          改过的配置文件备份
```

xsess 对各家工具的会话目录**只读**，唯一的例外是 `handoff --to` 显式创建新会话文件。

只读这件事比看上去微妙：用 `?mode=ro` 打开一个 WAL 模式的 SQLite 库，
它仍然会在人家目录里创建 `-shm` 和 `-wal` 两个伴生文件 —— 只读打开也会写。
所以有 WAL 时先快照到临时目录再读，没有 WAL 时用 `immutable=1` 直读，两条路都不留痕迹。

**索引体积**：跟你的会话总量成正比，量级参考「几百个会话 / 十几万条消息 → 数百 MB」。
大头是 trigram 全文索引 —— 它给每个三字窗口建索引，这是中文子串搜索的代价
（作为对照，Cursor 自己的 `state.vscdb` 也常有几百 MB）。
`xsess compact` 可以回收删除留下的空洞，但如果本来就没空洞，体积不会变 —— 那就是真实数据量。

---

## 测试

```bash
node --no-warnings --test 'tests/*.test.js'
```

适配器测试对着本机真实会话跑 —— Antigravity 或 Cursor 改存储格式时测试会先红，
而不是索引静默变空。本机没有某家工具的数据时对应测试自动跳过。

其中「某条会话的第一句应该是什么」这类断言需要你自己的数据，
复制 `tests/fixtures.local.example.json` 成 `tests/fixtures.local.json` 填上即可
（该文件已被 gitignore，不会进仓库）。没配的话这条测试自动跳过。
