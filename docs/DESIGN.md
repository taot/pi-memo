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
  archive/                       #   已归档，GC 挪进来，不进索引不进检索
  MEMORY.md                      #   L1 索引
  .cache/                        #   派生索引，可重建
  .git/                          #   L1 自成一个本地仓库，见 §3.2.3

<repo>/.pi/mneme/                # L2 项目内（随 repo 进 git）
  env/*.md                       #   项目 environment factual：架构、约定、构建命令、环境怪癖
  exp/*.md                       #   本项目经验：踩坑与结论
  archive/                       #   已归档，GC 挪进来
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

### 3.1.2 `env` 和 `exp` 怎么分

判据只有一条，且必须是可当场执行的：

> **能不能靠读代码、查文档、跑一条命令来核实？**
> 能 → `env`（一条可验证的陈述）
> 核实不了、只能相信我们试过 → `exp`（一个权衡后的选择）

不要用"是不是我们试出来的"来分——几乎每条记忆都是试出来的，这个轴分不开任何东西。

四个例子：

| | 记忆 | 怎么核实 |
|---|---|---|
| `global` × `env` | tokio 的 `block_in_place` 在 current_thread runtime 上会 panic | 查 tokio 文档 |
| `global` × `exp` | 这类 runtime 冲突优先改调用方的 runtime 类型，不要包 `spawn_blocking` 绕 | 无法核实，是取舍 |
| `project` × `env` | E2E 必须用 `PI_DIOXUS_AGENT_BIN` 指向 stub，否则要真 API key | 读 `src/agent/process.rs` |
| `project` × `exp` | 窗口定位改走 kdotool + KWin 脚本，没选"让断言不依赖绝对坐标" | 无法核实，是取舍 |

**为什么值得分成两个 kind**：`env` 天生可自动核对——`/mneme-gc` 可以重跑那条命令、grep 那个文件，判定记忆是否已陈旧（对应论文 §5.2.2 的 stability-plasticity 问题，在这类记忆上是可自动化的）。`exp` 没有这条路，只能靠你判断。混成一个 kind，这条自动化路径就没了。

**分不清时的兜底**：说明它是两条记忆被塞进了一条。拆开——一半是可核实的事实，另一半是我们的选择。这也是 §3.2"一文件 = 一条结论"约束的实际用法。

举个真实的例子：*"KDE Wayland 下程序设定窗口位置会静默失败，改用 kdotool"* 读起来像一条，其实是两条：前半句可以查 Wayland 协议文档核实（`env`），后半句是我们在两个方案里选了一个（`exp`，另一个选项是让断言不依赖绝对坐标）。拆开之后，前者未来可以自动查陈旧，后者进索引时会带上"为什么没选另一个"。

`pi-dioxus/docs/memory/` 里已有的手写笔记正好是 L2 `env/` 的内容，迁移即可。

### 3.2 记忆文件格式

承 §3.1.2，同一件事拆成两个文件。

`<repo>/.pi/mneme/env/wayland-no-window-positioning.md`：

```markdown
---
id: wayland-no-window-positioning
kind: env
title: Wayland 不暴露窗口坐标设定，KDE 下 set_outer_position 静默失败
created: 2026-08-31
updated: 2026-08-31
hits: 0
last_hit: null
status: active            # active | archived
supersedes: null
verify:
  kind: url
  ref: https://wayland.freedesktop.org/docs/html/
  expect: xdg-shell 里没有窗口定位请求
tags: [kde, wayland, winit]
---

Wayland 协议里没有"把窗口放到 (x, y)"这种请求。winit 的 `set_outer_position`
在 KDE 下不报错、也不生效，E2E 截图因此拿到错位的窗口。
```

`<repo>/.pi/mneme/exp/e2e-window-positioning-via-kdotool.md`：

```markdown
---
id: e2e-window-positioning-via-kdotool
kind: exp
title: E2E 窗口定位走 kdotool，没选"断言不依赖绝对坐标"
created: 2026-08-31
updated: 2026-08-31
hits: 0
last_hit: null
status: active
supersedes: null
because: [wayland-no-window-positioning]
tags: [e2e, screenshot, kdotool]
---

因为 [[wayland-no-window-positioning]]，E2E 无法自己摆窗口。两个可行方案：
用 `kdotool` 通过 KWin 脚本接口移动，或让断言完全不依赖绝对坐标。选了前者，
因为后者要重写全部截图基线。

**下次怎么办：** 沿用 kdotool。如果哪天基线本来就要重做，再考虑换第二个方案。
```

约束：
- 一个文件 = 一条记忆 = 一个可独立成立的结论。正文 ~200 字以内，超了通常说明该拆。
- `exp` 必须有"下次怎么办"。只描述现象不给行动的记忆，召回了也没用。
- `exp` 应写出**没选的那个方案**。少了它，将来条件变化时你无法判断这个选择还成不成立。
- `env` 应有 `verify:`，见 §3.2.1。写不出 `verify` 的，多半不是 `env`。
- `id` 即文件名（不含 `.md`），kebab-case，全局唯一。
- 两种引用，语义不同，不要混用，见 §3.2.2。
- `status` 只有两态，见 §3.2.3。"被取代"不是状态，是关系。

### 3.2.1 `verify` 字段

`env` 记忆的核实方法。结构化而非自由文本，因为 `/mneme-gc` 要能直接执行它（§7）。

```yaml
verify:
  kind: file            # file | command | url
  ref: src/agent/process.rs
  expect: PI_DIOXUS_AGENT_BIN
```

| `kind` | `ref` | `expect` | 判定方式 | 成本 |
|---|---|---|---|---|
| `file` | 仓库内相对路径 | 文件里必须仍能找到的子串 | 子串精确匹配 | 毫秒，确定 |
| `command` | 一条只读命令 | 输出里必须仍能匹配的子串 | 子串匹配输出 | 秒级，确定 |
| `url` | 文档链接 | 一句人话，说明该在那页看到什么 | 见下 | 秒到十几秒 + token，有噪声 |

三者的差别是成本和确定性的连续谱，不是"能跑"与"不能跑"。`url` 可以跑，但要再拆成两层，成本差一个量级：

1. **HTTP 状态**——免费。404 / 410 / 域名失效是零成本的强信号：这条记忆的依据本身没了。**默认开**。
2. **内容判断**——抓正文，问一次模型"这页还支持这条陈述吗"。`url` 的 `expect` 写成一句人话就是给这一步读的。要花 token、等网络，且文档改版会造成大量假阳性，所以**默认关**，用 `/mneme-gc --check-urls` 显式打开。

**内容判断的结论只能是"待核"，永远不能自动归档或改写记忆。** 抓回来的网页是不可信内容，让模型读外部页面去裁决你的记忆，这条路径上页面里的文字可能试图影响判断。摆给你看、由你定夺，与 §7 里 GC 只提候选是同一个原则。

两条硬约束：

- **`ref` 不写行号。** `process.rs:22` 在下一次编辑后就是错的，定位交给 `expect`。
- **`expect` 不能省。** 只判断"文件还在"几乎永远为真，抓不到任何陈旧；判断"那个环境变量名还在"才能抓到把它重命名掉的那次重构——这才是这个字段存在的理由。

`command` 必须是只读的（`grep` / `cat` / `--version` / `--help` 这类）。GC 会在你面前逐条跑，但它不该有能力改你的工作区。

**为什么没有单独的"来源"字段**：来源和核实方法多数时候是同一个东西，分成两个字段必然漂移。两者确实分叉时（例：某个 panic 是线上崩了才知道的，但核实要查文档），存**核实方法**——记忆系统的失败模式是陈旧而不是溯源，"当时为什么信"帮不上 GC 的忙。

### 3.2.2 `because:` 与 `[[id]]`

记忆之间有两种关系，只有一种需要结构化。

| | 语义 | 方向 | 可指向空 id | 参与陈旧传播 |
|---|---|---|---|---|
| `[[id]]`（写在正文里） | 相关，值得一起看 | 无 | 合法，标记一条还没写的记忆 | 否 |
| `because:`（写在 frontmatter） | **我的前提** | 有 | 非法，写入时校验 | 是 |

`because:` 存在的唯一理由是**陈旧传播**：`verify` 把一条 `env` 判为待核之后（§3.2.1），建立在它之上的 `exp` 同样可疑——那个选择的全部理由可能已经不成立了。GC 顺着反向索引把这些 `exp` 一并列出（§7 步骤 2）。没有这个字段，拆分 `env` / `exp` 只换来一个能自动查陈旧的 `env`，而依赖它的判断仍然静静地烂在那里。

多数 `because:` 指向 `env`。指向另一条 `exp` 也合法（一个选择建立在更早的选择之上），形成链，陈旧沿链传递。

反向也要用：`memory_forget` 一条仍被依赖的记忆时，先列出依赖方再让模型确认，不静默孤立它们。

### 3.2.3 `status` 与"被取代"

`status` 只有两态：

| | 含义 | 谁写 |
|---|---|---|
| `active` | 在用，进索引，可召回 | 默认 |
| `archived` | 有人明确决定不要了 | `memory_forget`，附 `archived_reason` |

**"被取代"不是状态，是关系**，由 `supersedes` 的反向索引推导：存在另一条 `active` 记忆 `supersedes: X`，则 X 自动退休——退出索引与检索，但文件仍在，`memory_recall` 用 `ids` 直接点名仍可读到（附带"已被 Y 取代"）。

之所以不设 `superseded` 状态，是因为那会把同一个事实存两遍，且失败模式很隐蔽：

> 你 `git revert` 掉了那条新记忆，旧条目上的 `status: superseded` 还在。旧记忆退出了索引和检索，却没有任何继任者——这条知识静默消失了，GC 也发现不了，因为它的状态"合法"。

推导则不会：新条目没了，反向索引里就没人取代它，旧条目自动回到 `active`。反向索引本来就要为 `because` 而建（§3.2.2），增量成本为零。

这与 `because` 是同一条原则：**关系写成结构化字段并单向存储，状态只描述有人主动做过的决定。**

**物理布局：status 是真相，目录是 GC 维护的物化视图。**

`memory_forget` 只翻 `status`，不动文件位置——快、可逆、不在会话中途制造路径变更。`/mneme-gc` 本来就要重建索引与缓存，顺手把 `status: archived` 的文件 `git mv` 进 `archive/`（保留 `env/` `exp/` 子结构）。

之所以不让 forget 当场移动：那样"这条记忆是否还在用"就同时由目录和 status 表示，两个真相源会打架——你手改 frontmatter 把 status 改回 `active`，文件却还躺在 `archive/` 里。因为 GC 是唯一动布局的地方，每次跑完两者按构造一致；跑之间以 status 为准。被 `supersedes` 自动退休的条目**不移动**，它随时可能因为继任者消失而复活（见上），移动会让这个推导失去意义。

**永不自动删除，两层都要有 git。**

`archive/` 只增不减。真要删是 `git rm`，你的决定。但这要求存储处在版本控制下——L2 随 repo 天然满足，**L1 不满足**，所以 `~/.pi/mneme/` 自己初始化成一个本地仓库，`/mneme-gc` 结束时提交一次（从不 push）。否则"删除可恢复"这个前提在全局层是空的，而 L1 装的恰恰是最难重建的东西：你的偏好和跨项目经验。附带收益是记忆演化有完整审计轨迹，对应论文 §7.7 把可审计列为可信记忆的支柱。

体量不是问题：一条记忆约 1 KB，一年归档几百条也就几百 KB。归档的真实成本是 `grep` 时的噪声，而这正是挪进 `archive/` 要解决的。

### 3.3 索引 MEMORY.md

自动生成，不手改（手改会被 `/mneme-gc` 覆盖）：

```markdown
# Project memory index

## env
- [build-and-check](env/build-and-check.md) — 改代码后跑 `npm run check`，不要跑 `npm test`
- [session-file-format](env/session-file-format.md) — session 是 JSONL，每行一个 entry
- [wayland-no-window-positioning](env/wayland-no-window-positioning.md) — Wayland 不暴露窗口坐标设定，KDE 下 set_outer_position 静默失败

## exp
- [e2e-window-positioning-via-kdotool](exp/e2e-window-positioning-via-kdotool.md) — E2E 窗口定位走 kdotool，没选"断言不依赖绝对坐标"
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
  body: Type.String({
    description:
      "The memory. For kind=exp, must end with what to do next time, and should name the option you did not take.",
  }),
  verify: Type.Optional(Type.Object({
    kind: Type.Union([Type.Literal("file"), Type.Literal("command"), Type.Literal("url")]),
    ref: Type.String({ description: "Repo-relative path (no line number), a read-only command, or a doc URL." }),
    expect: Type.String({ description: "Substring that must still be found in the file or command output." }),
  }, { description: "kind=env only. How to confirm this is still true. See §3.2.1." })),
  because: Type.Optional(Type.Array(Type.String(), {
    description:
      "ids this memory rests on as premises. Mostly env ids under an exp. " +
      "Every id must already exist — this is a dependency, not a soft link. See §3.2.2.",
  })),
  tags: Type.Optional(Type.Array(Type.String())),
  links: Type.Optional(Type.Array(Type.String(), { description: "ids of merely related memories (soft, may dangle)" })),
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

**不覆盖**：新建一条带新 id 的记忆，`supersedes: <old-id>`，`reason` 写进新条目的 frontmatter（`supersede_reason`）。旧文件不改状态——它由反向索引自动退休（§3.2.3），文件留在磁盘和 git 历史里。对应论文 §5.2.2 里 Zep 的时间戳软失效思路。

### `memory_forget` — 遗忘

```typescript
Type.Object({
  id: Type.String(),
  reason: Type.String(),
})
```

置 `status: archived`，把 `reason` 写进 `archived_reason`，移出索引。**不移动文件**——物理归档由 `/mneme-gc` 统一做（§3.2.3）。永不删文件。

`reason` 必须落盘。不写下来它就只是一次性的 tool call 参数，将来你看到一条被归档的记忆，只能去翻 git log 才知道当初为什么。

若这条记忆仍被别的记忆 `because:` 依赖（§3.2.2），先返回依赖方列表而不执行，让模型确认或改去处理依赖方。不静默把依赖悬空。

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
      * kindBoost          // 显式指定 kind 时非匹配项 *0.6（软偏好，不是过滤）
      * scopeBoost         // project 1.0, global 0.9（当前 repo 的知识优先）
      * recencyBoost       // 1 + 0.2 * exp(-age_days / 90)
      * hitBoost           // 1 + 0.1 * log(1 + hits)，论文 §5.2.3 的 frequency 信号
```

`status: archived` 以及被反向索引判定已退休的条目（§3.2.3）不进检索；用 `ids` 直接点名仍可读到。`.cache/` 里存倒排索引，纯 JSON，删了能重建。

升级路径已经留好：打分函数是单一入口，加一路 embedding 召回再做 RRF 融合，是局部改动。**触发条件是 §9 的召回质量指标恶化，不是"因为向量更高级"。**

---

## 7. 演化与遗忘

`/mneme-gc` 是唯一的批量整理入口，由你手动触发：

1. 列出候选：`hits == 0 且 age > 90d`（论文 §5.2.3 的 time + frequency 信号）、正文高度相似的对、指向不存在 id 的 `[[链接]]`、`status: archived` 但仍在索引里的条目、`supersedes` 指向不存在 id 的条目、缺 `verify:` 的 `env` 条目。
2. **`env` 陈旧检查**（§3.2.1），按成本分层：`file` / `command` 的 `expect` 匹配 + `url` 的 HTTP 状态默认跑，匹配不上就标为待核，把记忆正文和实际结果并排给你看；`url` 的内容判断由 `--check-urls` 控制，见 §7.1，且结论一律只是"待核"。
3. **陈旧传播**（§3.2.2）：上一步标为待核的每条 `env`，顺 `because:` 反向索引找出依赖它的 `exp`，一并列出——"这条选择的前提可能已经变了"。沿链传递。这是 `env` / `exp` 拆开的完整收益：`env` 可自动查陈旧，`exp` 靠依赖关系被带出来，两者都不会静静地烂掉。
4. 逐条问你：保留 / 归档 / 合并 / 改用 `memory_revise`。
5. 重建 MEMORY.md 和 `.cache/`，把 `status: archived` 的文件 `git mv` 进 `archive/`（§3.2.3），并在 L1 提交一次。

不自动跑。论文 §7.8 提倡的离线 consolidation（"睡眠"）能力更强，但它会花你没预算的 token 并改你没看过的文件——留到 M3 作为 opt-in。

### 7.1 `--check-urls` 的三态

`url` 内容判断要花 token 和网络时间（§3.2.1），所以它不能有一个静默的默认值——静默跳过和静默开销都是坏的。开关取三态：

| 调用 | 行为 |
|---|---|
| `/mneme-gc --check-urls=true` | 跑 |
| `/mneme-gc --check-urls=false` | 跳过 |
| `/mneme-gc`（未指定） | **弹对话问你**，不猜 |

对话必须带上成本，否则就是一个没信息量的 yes/no：

```
7 条 env 记忆带 url，其中 2 条 HTTP 状态已异常（已标待核）。
对余下 5 条抓取正文并让模型判断是否仍成立？
预计 5 次网络请求 + 5 次模型调用。
                                          [ 检查 ]  [ 跳过 ]
```

用 `ctx.ui.confirm()`（pi 为 interactive / RPC / print 各模式分别提供了实现）。

两条边界：

- **无法弹窗时（print 模式、无人值守）默认 `false`。** 花钱的操作在没人能回答的场合一律不做。此时在输出里写明"已跳过 N 条 url 检查，用 `--check-urls=true` 启用"，让跳过这件事仍然可见。
- **不记忆你的选择。** `/mneme-gc` 是手动、低频的操作，每次问一遍的成本远低于"上次选了跳过，这次也静默跳过"带来的意外。

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
| **M0** | store 层（frontmatter 全字段，含 `verify` / `because`）+ `memory_write` / `memory_recall` + 索引注入 | 手动写 5 条记忆，新会话里模型能召回正确的那条 |
| **M1** | `memory_revise` / `memory_forget` + BM25 打分 + `.cache/` | 迁移 `pi-dioxus/docs/memory/` 全部内容 |
| **M2** | `/mneme-gc` + `/mneme-stats`（§9 指标） | 连用两周，看指标 |
| **M3**（可选，看 M2 数据） | 向量召回；离线 consolidation；working memory（`session_before_compact`） | —— |

**`verify` 和 `because` 从 M0 就要写入，尽管消费它们的逻辑要到 M2 才有。** 这两个字段记的是写入当下才知道的信息——当时靠什么核实、这个选择建立在什么前提上。M0/M1 期间攒下的记忆如果缺了它们，事后无法重建，M2 的陈旧检查和传播也就无从跑起。字段先行、逻辑后补，代价只是几行 frontmatter。

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
