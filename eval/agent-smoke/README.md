# agent-smoke：跑一次真实 SWE 任务，看 agent 会不会写记忆

第一步的最小闭环。拿 SWE-ContextBench 经验池里的一道题，让真实 pi agent 在真实仓库上解，
全程加载 pi-memo，然后看它到底调没调 `memory_write`。

**不判分、不算指标、不跑 Docker。** 产出就是一份 tool trace 和一个 patch。

结果和结论见 [NOTES.md](NOTES.md)。

## 前置条件

| 需要 | 检查 |
|---|---|
| pi 已安装并配好鉴权 | `pi --version`，`~/.pi/agent/auth.json` 存在 |
| python3 | `python3 --version` |
| jq | `jq --version` |
| 读 parquet 的 venv | `ls ../swe-contextbench/.venv/bin/python` |
| 数据集 parquet | `ls ../swe-contextbench/data/*.parquet` |

`../swe-contextbench/data/` 和 `.venv/` 都在 `.gitignore` 里，是本地文件。
数据集来源见 [../swe-contextbench/README.md](../swe-contextbench/README.md)。

**每次运行都会真实调用 LLM**，一次约 20–25 个工具调用。

## 跑之前要清理什么

短答案：**基本不用手动清理**，`run.sh` 每次会把对应 arm 的目录整个删掉重建
（`worktree remove` → `rm -rf runs/<ARM>` → `worktree prune` → 重新 `worktree add`）。

真正要留意的只有两件事：

1. **`runs/` 是一次性的**，里面全是上一次运行的产物。想留证据就先改名：
   ```bash
   mv runs/A runs/A-$(date +%m%d-%H%M)
   ```
   否则下次跑 `./run.sh A` 就没了。

2. **手动删过 `runs/` 的话**，`repos/flask` 里会残留 worktree 注册信息。
   `run.sh` 开头已经带了 `worktree prune`，但想自己确认：
   ```bash
   git -C repos/flask worktree list
   ```
   只应看到 `repos/flask` 本身和当前存在的 `runs/*/workspace`。

**不需要**清理的：`repos/flask`（clone 一次反复用）、`instance.json`（固定数据）。

**不会被碰到的**：你真实的 `~/.pi/memo`。`run.sh` 把 `PI_MEMO_HOME` 指向
`runs/<ARM>/memo-global`，项目记忆则落在 workspace 里的 `.pi/memo/`。

## 跑

### 1. 抽一道题（只需一次）

```bash
../swe-contextbench/.venv/bin/python export_instance.py
```

写出 `instance.json`。默认 `pallets__flask-4045`——Lite 经验池里的小仓库任务，
gold patch 只改一个文件，好读。想换题就传 instance_id：

```bash
../swe-contextbench/.venv/bin/python export_instance.py psf__requests-2674
```

换题之后记得把下面 clone 的仓库也换掉（`run.sh` 里的 `repos/flask` 是写死的）。

### 2. clone 仓库（只需一次）

```bash
mkdir -p repos && git clone https://github.com/pallets/flask.git repos/flask
```

约 16MB。

> ⚠️ 这一步就是 NOTES.md 里说的那个坑：全量历史包含了**修复这道题的上游 commit**，
> agent 会 `git log --all` 翻出来直接抄。这是已知问题，还没修。

### 3. 跑

```bash
./run.sh A
```

```bash
./run.sh B
```

- **A** = 只给 SWE 任务（prompt 和官方生成那 300 条轨迹时用的一模一样）→ 看它**会不会自发写**
- **B** = 任务 + 一句「记下可复用的经验」→ 如果 A 不写，区分是**不想写**还是**不会写**

每次几分钟。

## 看结果

产物都在 `runs/<ARM>/`：

| 文件 | 内容 |
|---|---|
| `trace.jsonl` | 完整事件流（`pi --mode json` 的输出） |
| `patch.diff` | agent 改出来的代码，已排除 `.pi/`，可直接当 SWE-bench 的 `model_patch` |
| `prompt.txt` | 实际发给 agent 的提示 |
| `memo-global/` | 全局 store（隔离的） |
| `workspace/.pi/memo/` | 项目 store |
| `stderr.log` | pi 的错误输出 |

**主问题——它调了哪些工具：**

```bash
python3 -c "
import json,collections,sys
print(collections.Counter(json.loads(l)['toolName'] for l in open(sys.argv[1])
      if json.loads(l).get('type')=='tool_execution_start'))
" runs/A/trace.jsonl
```

A 应该看到 `memory_write` 计数为 0，B 应该是 1。

**它写了什么：**

```bash
find runs/B/memo-global runs/B/workspace/.pi -name '*.md' -exec cat {} +
```

**和标准答案比：**

```bash
python3 -c "
import json
gold=json.load(open('instance.json'))['patch']
f=lambda p:[l.split()[-1] for l in p.splitlines() if l.startswith('diff --git')]
print('gold:', f(gold))
print('A:   ', f(open('runs/A/patch.diff').read()))
"
```

gold 只动 `src/flask/blueprints.py` 一个文件；如果 agent 的 patch 还带上了
`CHANGES.rst` 和测试文件，说明它抄了上游 commit。

**它到底被告知了什么：**

```bash
node --experimental-strip-types dump_system_prompt.ts
```

pi 的系统提示由 `dist/core/system-prompt.js` 拼装：固定开头 + 每个工具的 `promptSnippet`
一行 + Guidelines（内置几条 + 所有工具的 `promptGuidelines`）+ pi 文档路径 +
`--append-system-prompt` + `<project_context>`（AGENTS.md/CLAUDE.md）+ skills + cwd。
pi-memo 就活在中间那两段里。改过 `src/tools/*.ts` 的提示文案之后跑一下，
确认 agent 看到的是你以为的那句话。

## 文件

| 文件 | 作用 |
|---|---|
| `dump_system_prompt.ts` | 打印 agent 实际看到的系统提示（含 pi-memo 注入的工具行和 guideline）；零成本，不调 LLM |
| `export_instance.py` | parquet → `instance.json` |
| `prompt.py` | `instance.json` + arm → 提示词 |
| `run.sh` | 建 workspace、隔离 store、跑 pi、抓 patch |
| `instance.json` | 当前这道题（已生成，可提交） |
| `NOTES.md` | 跑完的结论 |
| `repos/`、`runs/` | 本地产物，已 gitignore |
