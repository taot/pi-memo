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
所以不是「没得写」，是「不想写」。加一句话就写了，说明缺口在提示层不在能力层。

这直接决定了后续评测的 arm 设计：如果主 arm 用裸 SWE 提示，store 会一直是空的，
检索层再好也没有输入。

`memory_recall` 两次运行都是 0 次。session 启动时注入的 index 是空的（`_No memories yet._`），
agent 没有理由去 recall。这个要在 store 非空时重测——那才是真正的问题。

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
