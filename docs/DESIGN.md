# pi-mneme 设计

pi 的长期记忆扩展。它用人类可读的 Markdown 保存用户信息、项目环境事实和可复用经验，并在不同会话间提供检索。

## 1. 设计目标

- 记忆文件可读、可手改、可 diff，并可随项目进入 git。
- 写入、检索、更新和删除都由 LLM 显式调用工具完成。
- 每个 session 启动时注入轻量索引，让模型知道有哪些记忆可查。
- 每条记忆独立存储，不维护条目之间的关系。

## 2. 记忆类型与作用域

### 2.1 类型

| `kind` | 内容 |
|---|---|
| `user` | 用户的偏好、习惯和长期承诺 |
| `env` | 语言、库、平台或项目中可核实的事实 |
| `exp` | 实践中得到的经验和下次应采取的做法 |

`env` 和 `exp` 的区分方式：能通过读代码、查文档或运行只读命令核实的是 `env`；属于实践后的选择和经验的是 `exp`。

### 2.2 作用域

| `scope` | 含义 | 可用类型 |
|---|---|---|
| `global` | 换一个 repo 仍然成立 | `user`、`env`、`exp` |
| `project` | 只对当前 repo 成立 | `env`、`exp` |

`project × user` 非法，工具应直接报错。

## 3. 存储

```text
~/.pi/mneme/                     # 全局记忆
  user/*.md
  env/*.md
  exp/*.md
  MEMORY.md                      # 自动生成的索引
  .cache/                        # 可重建的检索缓存
  .local/usage.json              # 本机使用统计

<repo>/.pi/mneme/                # 项目记忆
  env/*.md
  exp/*.md
  MEMORY.md
  .cache/
  .local/usage.json
```

项目记忆随 repo 进入 git。`.cache/` 和 `.local/` 加入 gitignore。

### 3.1 记忆文件

一个文件保存一条可独立成立的结论。文件名为 `<id>.md`，正文通常不超过 200 字。

```markdown
---
id: wayland-no-window-positioning
kind: env
title: Wayland 不暴露窗口坐标设定，KDE 下 set_outer_position 不生效
created: 2026-08-31T14:22:07-04:00
updated: 2026-08-31T14:22:07-04:00
verify:
  kind: url
  ref: https://wayland.freedesktop.org/docs/html/
  expect: xdg-shell 中没有窗口定位请求
tags: [kde, wayland, winit]
---

Wayland 协议没有“把窗口放到 (x, y)”的请求。winit 的
`set_outer_position` 在 KDE 下不报错，也不生效。
```

字段约束：

- `id` 使用 kebab-case，并等于文件名；在全局与当前项目的组合视图中唯一。
- `title` 是一句可独立理解的结论，也是索引中的检索钩子。
- `created` 和 `updated` 使用带本地时区偏移的 ISO 8601 秒级时间。
- `env` 应提供 `verify`；`exp` 正文应包含“下次怎么办”。
- `tags` 可选。
- frontmatter 和正文都不保存对其他记忆条目的引用关系。

### 3.2 `verify`

```yaml
verify:
  kind: file            # file | command | url
  ref: src/agent/process.rs
  expect: PI_DIOXUS_AGENT_BIN
```

| `kind` | `ref` | 检查方式 |
|---|---|---|
| `file` | repo 内相对路径 | 文件内容包含 `expect` |
| `command` | 一条只读命令 | 命令输出包含 `expect` |
| `url` | 文档 URL | 默认检查 HTTP 状态；显式启用时再检查页面内容 |

`ref` 不带行号，`expect` 不能为空。`command` 在写入时由模型确认是只读命令。

### 3.3 索引

`MEMORY.md` 自动生成：

```markdown
# Project memory index

## env
- [build-and-check](env/build-and-check.md) — 改代码后运行 `npm run check`
- [wayland-no-window-positioning](env/wayland-no-window-positioning.md) — Wayland 不暴露窗口坐标设定

## exp
- [e2e-window-positioning-via-kdotool](exp/e2e-window-positioning-via-kdotool.md) — E2E 窗口定位使用 kdotool
```

每行只包含 id 和 title。索引由 `/mneme-gc` 或 session 启动时重建，不手工编辑。

## 4. 工具

### 4.1 `memory_recall`

```typescript
Type.Object({
  query: Type.String(),
  ids: Type.Optional(Type.Array(Type.String())),
  kind: Type.Optional(Type.Union([
    Type.Literal("user"),
    Type.Literal("env"),
    Type.Literal("exp"),
  ])),
  limit: Type.Optional(Type.Integer({ default: 5, maximum: 15 })),
})
```

按 query 检索，或用 ids 直接读取指定条目。返回全文、id 和 scope。命中的条目累计 `hits` 并更新 `last_hit`。

### 4.2 `memory_write`

```typescript
Type.Object({
  scope: Type.Union([Type.Literal("global"), Type.Literal("project")]),
  kind: Type.Union([
    Type.Literal("user"),
    Type.Literal("env"),
    Type.Literal("exp"),
  ]),
  id: Type.String(),
  title: Type.String(),
  body: Type.String(),
  verify: Type.Optional(Type.Object({
    kind: Type.Union([
      Type.Literal("file"),
      Type.Literal("command"),
      Type.Literal("url"),
    ]),
    ref: Type.String(),
    expect: Type.String(),
  })),
  tags: Type.Optional(Type.Array(Type.String())),
})
```

写入前按 id 和 title 查重。id 已存在时拒绝写入；标题高度相似时返回候选条目，让模型决定是否改用 `memory_revise`。

### 4.3 `memory_revise`

```typescript
Type.Object({
  id: Type.String(),
  title: Type.Optional(Type.String()),
  body: Type.Optional(Type.String()),
  verify: Type.Optional(Type.Union([
    Type.Object({
      kind: Type.Union([
        Type.Literal("file"),
        Type.Literal("command"),
        Type.Literal("url"),
      ]),
      ref: Type.String(),
      expect: Type.String(),
    }),
    Type.Null(),
  ])),
  tags: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
})
```

直接更新原文件，保留 `id`、`scope`、`kind` 和 `created`，并把 `updated` 设为当前时间。省略字段表示保持不变，`null` 表示清空可选字段。

### 4.4 `memory_forget`

```typescript
Type.Object({
  id: Type.String(),
})
```

直接删除对应的记忆文件，并从索引和检索缓存中移除。

### 4.5 工具引导

`promptGuidelines` 加入两条：

- 遇到与预期不符的环境行为，或花了多轮才解决的问题，解决后写一条 `exp`。
- 索引里有相关条目时先调用 `memory_recall` 获取全文，不根据索引标题猜测内容。

## 5. Session 生命周期

### 5.1 启动与索引注入

```typescript
let sessionIndex: AgentMessage;

pi.on("session_start", async () => {
  const sourceHash = hashMemoryFiles();
  rebuildCacheIfHashChanged(sourceHash);
  sessionIndex = indexMessage(renderIndex());
});

pi.on("context", async (event) => ({
  messages: [sessionIndex, ...event.messages],
}));
```

`session_start` 扫描全局和项目记忆。源文件哈希变化时重建缓存，并生成当前 session 的固定索引快照。新建、resume 和 fork 都重新加载。

全局与项目记忆出现同名 id 时，两条都不进入索引和检索缓存，并在索引消息中报告冲突路径。

索引最多注入 50 条或约 2000 token，先到者为准。超出时优先项目条目，再按 `last_hit` 从近到远排序；末尾提示剩余数量，并引导使用 `memory_recall` 搜索。

同一 session 中的写入、更新和删除立即落盘，但索引快照在下一个 session 才刷新。

### 5.2 使用统计

`memory_recall` 的命中增量先保存在内存中，`agent_settled` 时批量合并到各 store 的 `.local/usage.json`：

```json
{
  "wayland-no-window-positioning": {
    "hits": 3,
    "last_hit": "2026-09-01T09:12:03-04:00"
  }
}
```

删除记忆时同步删除对应的 usage 记录。

### 5.3 并发约束

同一个 store 同一时刻只允许一个 session 写入。多个 session 可以并发读取。

## 6. 检索

使用 BM25 检索，不同语言和代码标识符走同一套分词流程：

1. Unicode NFKC 规范化并转小写。
2. 中文使用 `nodejieba.cutForSearch()`。
3. 代码标识符同时保留完整 token 和拆分 token。例如 `tokio::block_in_place` 产生完整形式以及 `tokio`、`block_in_place`、`block`、`in`、`place`。
4. 去掉纯空白和标点。

打分：

```text
score = bm25(query, title*3 + body + tags*2)
      * kindBoost
      * scopeBoost
      * recencyBoost
      * hitBoost
```

- 显式指定 kind 时，匹配项优先。
- project 条目略高于 global 条目。
- `recencyBoost` 使用 `updated` 计算。
- `hitBoost` 使用 `.local/usage.json` 中的 hits。

`.cache/` 保存倒排索引、源文件哈希和 tokenizer 版本，均可从记忆文件重建。

## 7. `/mneme-gc`

`/mneme-gc` 由用户手动触发，依次执行：

1. 检查记忆文件格式和 id 冲突。
2. 执行 `env.verify` 检查。
3. 识别标题或正文高度相似的条目。
4. 找出超过 90 天仍未命中的条目。
5. 重建 `MEMORY.md` 和 `.cache/`。
6. 将结果写入 `<store>/GC-REPORT.md`。

报告只给出候选项和建议，不修改或删除记忆。处理结果由模型调用 `memory_revise` 或 `memory_forget` 落盘。

URL 默认只检查 HTTP 状态。`/mneme-gc --check-urls=true` 才抓取页面正文做内容检查；无 UI 且未显式指定时跳过内容检查。

## 8. `/mneme-stats`

输出：

- 总条目数，按 scope 和 kind 分组。
- `hits == 0` 的条目数量和占比。
- 每周新增与更新数量。
- 当前索引条目数、token 数和上限。

## 9. 代码结构与阶段

```text
pi-mneme/
  src/
    index.ts
    store/
      paths.ts
      entry.ts
      usage.ts
      index-file.ts
    retrieval/
      tokenize.ts
      bm25.ts
      score.ts
      cache.ts
    tools/
      recall.ts
      write.ts
      revise.ts
      forget.ts
    commands/
      gc.ts
      stats.ts
  test/
```

| 阶段 | 内容 | 验收 |
|---|---|---|
| M0 | store、`memory_write`、`memory_recall`、索引注入 | 新会话能召回已写入的记忆 |
| M1 | `memory_revise`、`memory_forget`、BM25、缓存 | 更新和删除立即落盘，新会话检索结果正确 |
| M2 | `/mneme-gc`、`/mneme-stats` | 连续使用两周并检查报告和指标 |

## 10. 已知风险

| 风险 | 应对 |
|---|---|
| 条目独立导致相关记忆不一致 | 接受；通过检索结果和 GC 重复检查人工处理 |
| 模型不调用 `memory_recall` | 常驻索引，并观察未命中比例 |
| 索引占用过多上下文 | 50 条 / 约 2000 token 上限 |
| 陈旧记忆误导 | `env.verify`、`updated` 和 GC 报告 |
| 项目记忆泄露用户信息 | `user` 只允许写入全局 store |
| 多 session 同时写入产生覆盖 | 同一 store 保持单写者 |
