# pi-mneme 设计

pi 的长期记忆扩展。让 pi 跨会话记住三件事：**你是谁**（偏好与承诺）、**这个代码库是什么样**（架构、约定、环境怪癖）、**上次踩过什么坑**（可复用的经验结论）。

设计参照 Hu et al., *Memory in the Age of AI Agents: A Survey* (arXiv 2512.13564v2)，下称"论文"。

![pi-mneme 架构](architecture.svg)

---

## 1. 范围

**做：**
- 三类长期记忆：user factual / environment factual / experiential(insight)
- 人类可读的 markdown 存储，可 diff、可手改、可进 git
- 记忆操作作为 LLM 显式 tool call
- 常驻注入一份轻量索引，让模型知道有什么可查

**v1 明确不做，及理由：**

| 不做 | 理由 |
|---|---|
| Working memory（上下文折叠/压缩） | pi 已有 compaction 机制（`session_before_compact`）。这是独立的工程问题，硬塞进来会让 v1 无法收敛。挂钩点留着，见 §8 M3。 |
| Parametric / latent memory（论文 3.2 / 3.3） | 需要训练或改推理栈，与"可读、可审计"的目标直接冲突。 |
| 图结构记忆（论文 3.1.2 / 3.1.3） | 构建与维护成本高，且论文自己指出 planar memory 的搜索成本"significantly hinder its practical deployment"。先用 flat + `[[id]]` 弱关联，等召回质量确实不够再上。 |
| Skill-based memory（可执行脚本，论文 4.2.3） | 引入执行安全、版本、失效检测一整套问题。pi 已有 skills 机制可以承接。 |
| 自动写入（会话结束蒸馏 / 离线 consolidation） | 见 §7。触发权保留给你。 |

---

## 2. 论文映射

| 论文维度 | 选择 | 理由 |
|---|---|---|
| **Form** (§3) | Token-level, **1D flat** + `[[id]]` 弱关联 | 可读、可 git、可手改。论文 §3.1.1 讨论：flat 的代价是"coherence and relevance depend heavily on retrieval quality"——所以检索质量是本设计的主要风险点，见 §6 和 §9。 |
| **Function** (§4) | Factual(user + environment) + Experiential(insight) | 覆盖 coding agent 收益最大的三块。 |
| **Formation** (§5.1) | Knowledge distillation，由 LLM 显式调用 | 不做 semantic summarization（会丢细节）。一条记忆 = 一个可独立成立的结论。 |
| **Evolution** (§5.2) | 软失效 + 手动 GC | 论文 §5.2.2 指出早期系统（MemGPT/Mem0）的 destructive replace "erasing valuable historical context and breaking temporal continuity"；Zep 改用时间戳软失效。我们照 Zep 的思路，且 git 本身就是历史。 |
| **Retrieval** (§5.3) | 常驻索引 + 显式 `memory_recall` | 论文 §7.2 主张把记忆操作变成 agent 的显式 tool call，理由是可解释、可追溯、行为一致。索引常驻是对 §5.3.1 提到的 silent failure mode 的对冲，见 §5.1。 |

---

## 3. 存储

### 3.1 三层作用域

```
~/.pi/mneme/                     # L1 全局（永不进 repo）
  user/*.md                      #   user factual：你的偏好、习惯、长期承诺
  env/*.md                       #   全局 environment factual：语言/库/平台的事实
  exp/*.md                       #   跨项目经验：与具体 repo 无关的通用结论
  MEMORY.md                      #   L1 索引
  .cache/                        #   派生索引，可重建

<repo>/.pi/mneme/                # L2 项目内（随 repo 进 git）
  env/*.md                       #   项目 environment factual：架构、约定、构建命令、环境怪癖
  exp/*.md                       #   本项目经验：踩坑与结论
  MEMORY.md                      #   L2 索引
  .cache/                        #   gitignore
```

### 3.1.1 scope × kind 矩阵

`scope` 回答"换个 repo 还成立吗"，`kind` 回答"这是什么性质的知识"。两者正交：

| | `kind: user` | `kind: env`（事实） | `kind: exp`（经验） |
|---|---|---|---|
| **`scope: global`**（L1） | 你的偏好与承诺 | 语言/库/平台的事实 | 跨项目的通用结论 |
| **`scope: project`**（L2） | — | 本 repo 的架构与约定 | 本 repo 的踩坑 |

唯一的非法组合是 `project` × `user`：关于你的事实永远属于 L1，永远不进 repo。工具层校验并给出明确报错，不静默改写。

判断规则写进 tool description：
- `env` vs `exp`：**这个世界本来就是这样** → `env`；**我们试过才知道，下次要换个做法** → `exp`
- `global` vs `project`：换个 repo 仍然成立 → `global`

三个例子，正好覆盖三种典型：
- `global` × `env` — *tokio 的 `block_in_place` 在 current_thread runtime 上会 panic*（库的属性，不是我们的经验）
- `project` × `env` — *本项目 E2E 必须用 `PI_DIOXUS_AGENT_BIN` 指向 stub，否则要真 API key*
- `project` × `exp` — *KDE Wayland 下程序设定窗口位置会静默失败，改用 kdotool*

**为什么 `env` 和 `exp` 必须分开**：`exp` 强制要求"下次怎么办"这一段（§3.2）。一条纯事实写不出这段，硬凑只会污染记忆质量。这条约束是 `env`/`exp` 分类的实际判据——写不出行动项，说明它是 `env`。

`pi-dioxus/docs/memory/` 里已有的手写笔记正好是 L2 `env/` 的内容，迁移即可。

### 3.2 记忆文件格式

`<repo>/.pi/mneme/exp/kde-wayland-window-positioning.md`：

```markdown
---
id: kde-wayland-window-positioning
kind: exp
title: KDE Wayland 下无法用程序设定窗口位置
created: 2026-08-31
updated: 2026-08-31
hits: 0
last_hit: null
status: active            # active | superseded | archived
supersedes: null
tags: [kde, wayland, e2e, screenshot]
---

Wayland 协议不暴露窗口坐标设定，`set_outer_position` 在 KDE 下静默失败，
E2E 截图因此拿到错位的窗口。

**下次怎么办：** 用 `kdotool` 通过 KWin 脚本接口移动窗口，或让 E2E
断言不依赖绝对坐标。见 [[e2e-screenshot-harness]]。
```

约束：
- 一个文件 = 一条记忆 = 一个可独立成立的结论。正文控制在 ~200 字以内，超了就该拆。
- `exp` 类必须有"下次怎么办"这一段。只描述现象不给行动的记忆，召回了也没用。
- `id` 即文件名（不含 `.md`），kebab-case，全局唯一。
- `[[id]]` 是软链接，指向不存在的 id 不是错误——它标记了一条还没写的记忆。

### 3.3 索引 MEMORY.md

自动生成，不手改（手改会被 `/mneme-gc` 覆盖）：

```markdown
# Project memory index

## env
- [build-and-check](env/build-and-check.md) — 改代码后跑 `npm run check`，不要跑 `npm test`
- [session-file-format](env/session-file-format.md) — session 是 JSONL，每行一个 entry

## exp
- [kde-wayland-window-positioning](exp/kde-wayland-window-positioning.md) — KDE Wayland 下程序设定窗口位置会静默失败
```

每条一行：id + 一句钩子（取自 title）。**索引是唯一常驻进 context 的东西**，预算见 §5.1。

---

## 4. 工具面

四个工具，对应论文 Dynamics 的三个算子（§5.1 formation / §5.2 evolution / §5.3 retrieval）。

### `memory_recall` — 检索

```typescript
Type.Object({
  query: Type.String({ description: "What you need to know. Natural language." }),
  ids: Type.Optional(Type.Array(Type.String(), {
    description: "Fetch these memories by id directly. Use when the index already showed you what you need.",
  })),
  kind: Type.Optional(Type.Union([Type.Literal("user"), Type.Literal("env"), Type.Literal("exp")])),
  limit: Type.Optional(Type.Integer({ default: 5, maximum: 15 })),
})
```

返回命中记忆的全文 + id + scope。副作用：`hits += 1`，`last_hit = now`（记账写回 frontmatter，见 §9）。

### `memory_write` — 形成

```typescript
Type.Object({
  scope: Type.Union([Type.Literal("global"), Type.Literal("project")], {
    description: "global = still true in another repo. project = only true here.",
  }),
  kind: Type.Union([Type.Literal("user"), Type.Literal("env"), Type.Literal("exp")], {
    description:
      "user = a fact about the person you work with (forces scope=global). " +
      "env = how the world already is (a library, a platform, this repo's layout). " +
      "exp = what we learned by trying, and what to do differently next time.",
  }),
  id: Type.String({ description: "kebab-case, unique. e.g. tokio-block-in-place-panics" }),
  title: Type.String({ description: "One line. This is what shows up in the index — make it a claim, not a topic." }),
  body: Type.String({ description: "The memory. For kind=exp, must end with what to do next time." }),
  tags: Type.Optional(Type.Array(Type.String())),
  links: Type.Optional(Type.Array(Type.String(), { description: "ids of related memories" })),
})
```

写入前先按 `id` 和 `title` 做一次相似检查，命中就返回"已有 `<id>`，考虑用 `memory_revise`"，不直接写。这是论文 §5.2.1 的 local consolidation 的最廉价版本。

### `memory_revise` — 更新

```typescript
Type.Object({
  id: Type.String(),
  body: Type.String(),
  reason: Type.String({ description: "Why the old version was wrong or incomplete." }),
})
```

**不覆盖**：旧文件 `status: superseded`，新文件带新 id 且 `supersedes: <old-id>`。旧文件退出索引但留在磁盘和 git 历史里。对应论文 §5.2.2 里 Zep 的时间戳软失效思路。

### `memory_forget` — 遗忘

```typescript
Type.Object({
  id: Type.String(),
  reason: Type.String(),
})
```

只置 `status: archived` 并移出索引。永不删文件——真要删，用 `git rm`，那是你的决定。

### 工具描述里要写进去的引导

`promptGuidelines` 挂两条：
- 遇到与预期不符的环境行为、或花了多轮才搞定的问题，解决之后写一条 `exp`。
- 索引里有相关条目时先 `memory_recall` 取全文，不要凭索引里那一行猜内容。

---

## 5. 生命周期挂钩

pi 的扩展 API（`packages/coding-agent/src/core/extensions/types.ts`）提供的挂钩，我们只用三个。

### 5.1 `context` — 注入索引

```typescript
pi.on("context", async (event) => {
  const block = renderIndex();           // L1 + L2 合并后的索引
  const messages = stripPrevious(event.messages, MNEME_MARKER);
  return { messages: [...messages, indexMessage(block)] };
});
```

要点：
- 用 marker 保证 context 里**永远只有一份**索引，且永远是最新的（记忆在会话中途被写入时索引会变）。
- 位置放在消息尾部而非系统提示：长会话里尾部注意力更好，且不需要动 `BuildSystemPromptOptions`。
- **Token 预算 600**。超了就按 `scope` 优先级 + `last_hit` 近度截断，并在末尾标注 `(N more, use memory_recall to search)`。索引无声地膨胀到几千 token 是这个设计最现实的退化路径。

不用 `resources_discover`：那个事件只接受 `skillPaths` / `promptPaths` / `themePaths`，不是通用注入点。

### 5.2 `session_start` — 加载

扫描 L1 + L2，构建/校验 `.cache/` 索引（按文件 mtime 判断是否需要重建），渲染索引块。`reason` 为 `resume`/`fork` 时同样重建——记忆可能在别的会话里改过了。

### 5.3 `agent_settled` — 只做记账

把 `memory_recall` 累积的 hit 计数批量写回 frontmatter。**不做任何自动蒸馏或整理**——这是你选的边界，我在这里守住它。

---

## 6. 检索实现

v1 不引入 embedding，理由是三层记忆的规模在几百条量级，且引入向量就要引入模型依赖、缓存失效、维度迁移一整套问题，收益未经验证。

打分（论文 §5.3.3 的 lexical + §5.3.4 的 re-ranking）：

```
score = bm25(query, title*3 + body + tags*2)
      * kindBoost          // 显式指定 kind 时非匹配项 *0.3
      * scopeBoost         // project 1.0, global 0.9（当前 repo 的知识优先）
      * recencyBoost       // 1 + 0.2 * exp(-age_days / 90)
      * hitBoost           // 1 + 0.1 * log(1 + hits)，论文 §5.2.3 的 frequency 信号
```

`status != active` 的条目不进检索。`.cache/` 里存倒排索引，纯 JSON，删了能重建。

升级路径已经留好：打分函数是单一入口，加一路 embedding 召回再做 RRF 融合，是局部改动。**触发条件是 §9 的召回质量指标恶化，不是"因为向量更高级"。**

---

## 7. 演化与遗忘

`/mneme-gc` 是唯一的批量整理入口，由你手动触发：

1. 列出候选：`hits == 0 且 age > 90d`（论文 §5.2.3 的 time + frequency 信号）、正文高度相似的对、指向不存在 id 的 `[[链接]]`、`status != active` 但仍在索引里的条目。
2. 逐条问你：保留 / 归档 / 合并。
3. 重建 MEMORY.md 和 `.cache/`。

不自动跑。论文 §7.8 提倡的离线 consolidation（"睡眠"）能力更强，但它会花你没预算的 token 并改你没看过的文件——留到 M3 作为 opt-in。

**长尾风险**：论文 §5.2.3 明确警告 LRU 类策略"may eliminate long-tail knowledge, which is seldom accessed but essential for correct decision-making"。一条一年只用一次但每次都救命的记忆，恰恰是最有价值的。所以 GC 只提候选、由你定夺，且归档不删文件。

---

## 8. 代码结构与阶段

```
pi-mneme/
  src/
    index.ts            # 扩展入口，注册 tools/commands/hooks
    store/
      paths.ts          # 三层作用域解析
      entry.ts          # frontmatter 读写、id 校验
      index-file.ts     # MEMORY.md 渲染
    retrieval/
      bm25.ts
      score.ts          # 单一打分入口
      cache.ts
    tools/
      recall.ts write.ts revise.ts forget.ts
    commands/
      gc.ts stats.ts
  test/
```

安装到 `~/.pi/agent/extensions/` 或 `<repo>/.pi/extensions/`（两处都支持 `/reload` 热重载）。

| 阶段 | 内容 | 验收 |
|---|---|---|
| **M0** | store 层 + `memory_write` / `memory_recall` + 索引注入 | 手动写 5 条记忆，新会话里模型能召回正确的那条 |
| **M1** | `memory_revise` / `memory_forget` + BM25 打分 + `.cache/` | 迁移 `pi-dioxus/docs/memory/` 全部内容 |
| **M2** | `/mneme-gc` + `/mneme-stats`（§9 指标） | 连用两周，看指标 |
| **M3**（可选，看 M2 数据） | 向量召回；离线 consolidation；working memory（`session_before_compact`） | —— |

---

## 9. 可观测性

这是本设计里唯一必须自动化的部分。论文 §5.3.1 的结论值得原样记住：当 agent 高估自己的知识、不去检索时，**系统会静默失效，没有任何错误信号**。既然写入和读取都交给了模型自觉，就必须能测出"模型到底有没有用"。

`/mneme-stats` 输出：

- **召回率**：有多少比例的会话至少调用过一次 `memory_recall`
- **命中分布**：`hits == 0` 的记忆占比（写了从没被用过的死记忆）
- **写入率**：每周新增多少条，分 scope
- **索引压力**：当前索引 token 数 / 600 预算

判据：跑两周后如果 `hits == 0` 的记忆超过 60%，说明**要么写入质量差**（写了没用的东西）**要么召回失效**（模型不调工具）。两者的处理方式完全不同——前者改 `memory_write` 的引导语，后者才考虑加自动预检索。先量出来是哪个，再改。

---

## 10. 已知风险

| 风险 | 缓解 |
|---|---|
| 模型不调 `memory_recall`（silent failure） | 常驻索引 + §9 埋点。数据说话，不预先加自动检索。 |
| 索引膨胀吃 context | 600 token 硬预算 + 截断 + `/mneme-stats` 监控 |
| 记忆写得太碎或太水 | 一文件一结论、`exp` 强制"下次怎么办"、写入前查重 |
| 陈旧记忆误导（论文 §5.2.2 的 stability-plasticity） | `supersedes` 链 + `updated` 时间戳进索引行 |
| 项目层记忆进 git 泄露隐私 | user 层强制在 `~/.pi/`，永不进 repo；`.cache/` 默认 gitignore |
| flat 结构在多跳问题上召回不足 | §9 指标恶化时才上向量/图，打分函数已是单一入口 |
