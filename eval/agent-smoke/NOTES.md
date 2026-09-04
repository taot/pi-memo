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

## 结论 3：patch 提取口径要定死

两次运行都改了测试文件。SWE-bench 的判分流程是先打官方 `test_patch` 再打 `model_patch`，
agent 改测试要么被覆盖要么冲突。后续要么在提示里禁止改测试，要么提 patch 时按路径过滤。

`git diff -- . ':(exclude).pi'` 已经能正确排除 pi-memo 自己写进 workspace 的
`.pi/memo/`，这一处接缝是通的。
