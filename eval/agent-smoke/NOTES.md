# 第一次真实运行：agent 会不会写记忆

任务：`pallets__flask-4045`（SWE-ContextBench Lite 经验池，"Raise error when blueprint
name contains a dot"）。真实 pi agent（`openai-codex/gpt-5.6-sol`），加载 pi-memo，
`-ne -ns -nc` 只挂 pi-memo 一个扩展。隔离 store，真实 `~/.pi/memo` 未被触碰。

```bash
./run.sh A   # 只给 SWE 任务
./run.sh B   # 任务 + "记下可复用的经验"
```

## 结论 1：agent 不会自发写记忆

| 运行 | 工具调用 | `memory_write` | `memory_recall` |
|---|---|---|---|
| A（裸任务） | 22 | **0** | 0 |
| B（加一句提示） | 25 | 1 | 0 |

扩展确实加载了——A 的 store 里生成了 `MEMORY.md` 和 `.cache/index.json`，只是全程没被调用。

### 不是「没人告诉它」

`node --experimental-strip-types dump_system_prompt.ts` 还原了 agent 实际看到的系统提示。
四个工具和四条 guideline 都在里面：

```
Available tools:
  ...
- memory_recall: Read or search stored long-term memories (user, env, exp)
- memory_write: Store a durable memory (user preference, verifiable fact, or experience)
- memory_revise: Update a stored memory in place
- memory_forget: Delete a stored memory

Guidelines:
- When the memo memory index lists an entry that looks relevant, call memory_recall ...
- Write a verifiable cause or fact as an `env` memory with memory_write, and the
  strategy or what-to-do-next-time as an `exp` memory; write both when a lesson has each.
- When a stored memory turns out to be outdated rather than wrong in kind, update it
  with memory_revise instead of writing a second entry about the same thing.
- Delete a memory with memory_forget only when it is wrong or obsolete, not merely unused.
```

被明确告知了，然后调用了 0 次。

### 为什么：四条 guideline 里没有一条说「什么时候写」

逐条看它们的语法结构：

| guideline | 结构 | 这次运行里 |
|---|---|---|
| recall | **有触发条件**——「当 index 里列出看起来相关的条目时」 | index 是 `_No memories yet._`，条件为假，空转 |
| write | 只有**分类法**——「把可验证的事实写成 `env`，把下次怎么办写成 `exp`」 | 说的是「写成哪种」，从没说「何时写」 |
| revise | 「**而不是**再写一条」 | 限定语，只在已经要写时才生效 |
| forget | 「**只在**错了或过时时」 | 限制条件，收紧而非触发 |

四条里只有一条带触发条件，而那个条件恰好为假。没有任何一句是
「任务做完后，把学到的记下来」。

这也解释了 B 组：那句 nudge 提供的正是缺失的触发时机，一给就写了。
**缺口在触发条件，不在分类法，也不在能力。**

> **已改，但没用**：四个工具的 `promptGuidelines` 各补了一条触发条件，原有的分类法/限制
> 作为从句保留。recall 加「上手不熟悉的部分、或撞到没见过的报错和约定时先搜」（并显式说明
> index 为空时跳过，避免冷启动空转）；write 加「收尾前判断这次学到的东西是否『早知道
> 能省时间』」，配一句反面清单（显而易见的、流水账的不写）和一句「没有就不写」；
> revise 和 forget 改写成触发条件在前的句式。判断什么重要交给模型，不列清单。
>
> 改完重跑 arm A **四次**（`runs/A-trigger-1..4`，都在快照 workspace 上）：
>
> | run | 总工具调用 | `memory_*` | patch |
> |---|---|---|---|
> | 1 | 211 | **0** | 3 files |
> | 2 | 238 | **0** | 4 files |
> | 3 | 126 | **0** | 2 files |
> | 4 | 213 | **0** | 2 files |
>
> 四次全零，一次 `memory_*` 都没调。所以 n=1 的 0 不是噪声。

### 追加结论：system prompt 层的 guideline 权重不够

送达是没问题的——`dump_system_prompt.ts` 能看到全部六条；另外单独探了一次，让模型复述自己的
系统提示，它答的是「assist with coding tasks, use available tools appropriately, make precise
edits, verify work, **manage relevant memories**, and keep responses concise」，说明记忆相关的
指令确实在它眼里。

而且素材是有的：run 1 收尾时自己说「Tests could not run because `pytest` and runtime
dependencies are not installed」——这是标准的 `env` 记忆素材，它照样没写。

对比 B 组：同一句话放进 **user message** 就写了。差别不在措辞，在**注入位置**——
system prompt 的 guideline 比会话里的指令低一档，一个 200+ 步的编码任务足以把它稀释掉。

下一步的方向是把触发条件挪到（或复制到）注入的 `memo-index` 消息里，那是会话内的
message，权重接近 B 组那句有效的 nudge。

### 又一个否定结果：index 表头的 nudge 同样无效

`renderSessionIndex` 结尾加了 `CLOSING_NUDGE`（"Before you finish this task, store
anything you learned that would have saved you time at the start"），重跑 arm A 四次
（`runs/A-nudge-1..4`，trace 482–1907 行）：**`memory_*` 依然 0 次，4/4**。

汇总：

| 批次 | 触发条件所在位置 | n | `memory_write` |
|---|---|---|---|
| 最初的 A | 无 | 1 | 0 |
| `A-trigger-1..4` | system prompt 的 guideline | 4 | 0 0 0 0 |
| `A-nudge-1..4` | guideline + index 表头 | 4 | 0 0 0 0 |
| 最初的 B | **user message（拼在任务陈述里）** | 1 | **1** |

### 送达没有问题——payload dump 实测

写了个一次性扩展挂 `before_provider_request`，把真实请求体落盘（`event.payload`，
和 pi-telemetry 送进 langfuse 的是同一个对象）：

- `instructions`（4734 字符，即 system prompt）**包含**那条 write guideline；
- `input[0]` **包含**整段 memo index 和 `CLOSING_NUDGE`；
- `tools[]` 里四个 memory 工具都在。

模型也确实读得到：单独探针里让它复述 index，它把整段连同 nudge 逐字背了出来。

**所以"看不见"只是 langfuse 的面板问题**——tool 面板只渲染 `tools[]`，而
`promptGuidelines` 不属于 tool schema（pi 把它折进 `instructions`），nudge 则在
Input 第 0 条消息里。两处都要去 generation 的 System / Input 里看。

### 修正前面的判断

dump 里最值得注意的是：pi 把注入的 snapshot 转成了普通的 **`role: "user"` 消息**，
排在 `input[0]`。也就是说它和 B 组那句有效的 nudge **走的是同一个通道**。

所以「system prompt 权重不够、挪到会话消息里就行」这个解释是错的——两者都试过，都是 0。
真正的差别只剩位置：`input[0]` 是任务陈述**之前**的独立前言，B 组那句拼在 `input[1]`
的任务陈述**里面**。变量不是 system-vs-user，而是**这句话算不算任务的一部分**。

对应的下一个假设：`context` 钩子目前是 `[sessionIndex, ...messages]`，改成把提醒追加到
**末尾**（`[..., reminder]`），紧贴任务陈述之后。**尚未验证。**

另一个一直没排除的混淆变量：这 9 次全是 `pi -p` 一次性非交互运行，agent 干完即退出，
不存在"下一次会话"。这个模式本身可能就抑制了写入动机。



### 冷启动是闭环的

空 store → 注入的 index 是空的 → recall 的触发条件永远为假 → 不 recall；
同时 write 没有触发条件 → 不写 → store 保持为空。

这直接决定了后续评测的 arm 设计：主 arm 如果用裸 SWE 提示，store 会一直是空的，
检索层再好也没有输入。

`memory_recall` 的 0 次要在 **store 非空时重测**才有意义——那时 index 里有东西，
recall 的触发条件才第一次成立。

## 结论 2：worktree 泄漏了未来提交，agent 直接抄了答案

用 `git clone` 全量历史 + detach 到 `base_commit` 建 workspace，**修复该 issue 的上游 commit
仍然在 `git log --all` 里**。两次运行都找到了：

```
git log --all --oneline -S"may not contain a dot" -- src/flask/blueprints.py
  → 7c526140 blueprint name may not contain a dot
git show 7c526140 -- src/flask/blueprints.py tests/... CHANGES.rst
```

产出的 patch 是上游 commit 的完整复刻——包括 `CHANGES.rst` 和两个测试文件，
而 gold patch 只改 `src/flask/blueprints.py` 一个文件。

更值得注意的是 B 写下的那条记忆，把这件事固化成了「方法论」：

> This checkout retains later upstream Flask history even when HEAD is detached at an
> older base commit. For similar repository tasks, first search `git log --all` using
> issue numbers and problem-statement keywords, then inspect matching commits with
> `git show`; this can reveal the intended patch...

也就是说，在这套 workspace 下跑「经验积累」，agent 学到的最有效经验是**怎么从 git 历史里
翻答案**，而不是怎么解决问题。这会把整个「经验复用有收益」的结论污染掉。

注意：官方 `Dockerfile.instance` 也是 `git clone` 全量 + `git checkout ${BASE_COMMIT}`，
所以同样的泄漏在上游镜像里也存在。我们自己的 harness 至少要把 workspace 换成
无未来历史的快照（`git archive` 出 tree 后重新 `git init`，或 `fetch --depth 1 <sha>`）。

> **已修**：`run.sh` 不再用 `git worktree`。改成 `git archive "$BASE"` 取出 tree，
> 解到空目录后 `git init` + 单次 commit，workspace 于是只有一个 commit、没有 remote、
> 没有未来 refs。`repos/flask` 只当 tree 的来源，历史和 refs 不再泄漏进去。脚本随后断言
> `rev-list --count HEAD == 1`，谁把 worktree 改回来都会直接报错退出。
>
> 选 `git archive` 而不是 `fetch --depth 1 <sha>`：后者要联网，还依赖服务端开
> `uploadpack.allowReachableSHA1InWant`。
>
> 副作用：prompt 里的 `base_commit` sha 在 workspace 里已经解析不出来了。这是刻意的——
> arm A 要逐字复刻 SWE-ContextBench 的提示，而 agent 去 `git show` 一个它本来就不该有的
> 提交时，失败才是正确行为。
>
> 旧 run 里 B 写下的那条 `exp/use-upstream-history-for-fixes` 记忆把这个漏洞固化成了
> 方法论，重跑该 arm 会随 `rm -rf "$RUN"` 一起清掉；想留作「修复前」的证据就先
> `mv runs/B runs/B-preleakfix`。

## 结论 3：patch 提取口径要定死

两次运行都改了测试文件。SWE-bench 的判分流程是先打官方 `test_patch` 再打 `model_patch`，
agent 改测试要么被覆盖要么冲突。后续要么在提示里禁止改测试，要么提 patch 时按路径过滤。

`git diff -- . ':(exclude).pi'` 已经能正确排除 pi-memo 自己写进 workspace 的
`.pi/memo/`，这一处接缝是通的。
