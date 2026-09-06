# agent-smoke：跑一次真实 SWE 任务，看 agent 会不会写记忆

第一步的最小闭环。拿 SWE-ContextBench 经验池里的一道题，让真实 pi agent 在真实仓库上解，
全程加载 pi-memo，然后看它到底调没调 `memory_write`。

**不判分、不算指标、不跑 Docker。** 产出就是一份 tool trace 和一个 patch。

结果和结论见 [NOTES.md](NOTES.md)。

## 前置条件

| 需要 | 检查 |
|---|---|
| pi 已安装并配好鉴权 | `pi --version`，`~/.pi/agent/auth.json` 存在 |
| pi-sandbox（网络隔离） | `ls ~/.pi/agent/npm/node_modules/pi-sandbox/index.ts` |
| ripgrep（缺了沙箱静默关闭） | `command -v rg` |
| uv（建任务的 Python 环境） | `uv --version` |
| python3 | `python3 --version` |
| jq | `jq --version` |
| 读 parquet 的 venv | `ls ../swe-contextbench/.venv/bin/python` |
| 数据集 parquet | `ls ../swe-contextbench/data/*.parquet` |

`../swe-contextbench/data/` 和 `.venv/` 都在 `.gitignore` 里，是本地文件。
数据集来源见 [../swe-contextbench/README.md](../swe-contextbench/README.md)。

**每次运行都会真实调用 LLM**，一次约 20–25 个工具调用。

## 跑之前要清理什么

短答案：**基本不用手动清理**，`run.sh` 每次会把对应 arm 的目录整个删掉重建
（`rm -rf runs/<ARM>` → 从 `repos/flask` 浅克隆一个钉在 `base_commit` 的分支）。

真正要留意的只有两件事：

1. **`runs/` 是一次性的**，里面全是上一次运行的产物。想留证据就先改名：
   ```bash
   mv runs/A runs/A-$(date +%m%d-%H%M)
   ```
   否则下次跑 `./run.sh A` 就没了。

2. **早期版本的 `run.sh` 用 worktree 建 workspace**，`repos/flask` 里可能残留注册信息。
   现在的 `run.sh` 不再建 worktree，开头的 `worktree prune` 会清掉这些残留。想自己确认：
   ```bash
   git -C repos/flask worktree list
   ```
   只应看到 `repos/flask` 本身。

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

约 16MB。全量历史包含了**修复这道题的上游 commit**，所以这个 clone 只当 tree 的来源用，
它的历史和 refs 不进 workspace。

`run.sh` 在 `repos/flask` 里把一个临时分支钉到 `base_commit`，然后
`git clone --depth 500 --single-branch --branch <该分支> file://...`，再删掉 remote。
workspace 因此有**到 base 为止的真实历史**、没有 remote、没有未来 commit 和未来 tag
（`--single-branch` 只带回该分支历史里的 tag，最新一个是 `2.0.0`）。
`file://` 是必须的：本地路径克隆会硬链接整个 object DB 并忽略 `--depth`。

早先的版本用 `git worktree`，workspace 与 clone 共享 object DB 和全部 refs，agent
`git log --all` 就能翻出上游修复直接抄——见 NOTES.md 结论 2；再早先的修法是
`git archive` + 单次 commit，堵住了泄漏，但也把仓库自己的历史一并拿走了（结论 7）。

脚本自己断言 HEAD == base、克隆是 shallow、`rev-list --all --not HEAD` 为空、没有 remote，
四条任一不成立就退出。想手动确认没退化：

```bash
git -C runs/A/workspace rev-parse HEAD            # = instance.json 的 base_commit
git -C runs/A/workspace rev-list --all --not HEAD | wc -l   # 0
git -C runs/A/workspace log --all -S'may not contain a dot' -- src/flask/blueprints.py  # 空
```

### 3. 网络隔离（自动，但有前置依赖）

只堵本地 git 历史不够——agent 会改用 `bash` 里的 `curl` / `python urllib` 去
`api.github.com` 和 `pypi.org` 拿同一个修复（NOTES.md 结论 4）。

`run.sh` 靠 `pi-sandbox` 挡这条路：显式 `-e` 加载它（`-ne` 会让它跟着一起被禁用），
并在 workspace 里写 `.pi/sandbox.json` 设 `deniedDomains: ["*"]`。它只包住 bash 工具，
pi 自己连模型不受影响。两个依赖缺一不可，缺了 `run.sh` 直接退出而不是静默裸奔：

```bash
ls ~/.pi/agent/npm/node_modules/pi-sandbox/index.ts   # pi package
command -v rg                                          # 缺了沙箱会静默关闭
```

每次运行产出 `net-blocked-count.txt`。非零是**正常**的，说明 agent 试图外联并被拒绝；
为零则要么它这次没试，要么沙箱没生效——先看 `stderr.log` 再下结论。

### 4. 任务的 Python 环境（自动）

因为 agent 没网，依赖必须在这里（沙箱外）装好，否则它跑不了测试，只能 `py_compile`
看语法，然后把「这个 checkout 没装依赖」当成经验记下来——那是我们 harness 的毛病，
不是这道题的性质（NOTES.md 结论 6）。

`run.sh` 用 `uv` 在 `workspace/.venv` 建环境，并用 `--exclude-newer <instance 的 created_at>`
按**题目当时的时间点**解析依赖。这一步不能省：flask 2.0 写的是 `Werkzeug>=2.0`，
今天解析会装到 3.x，import 直接挂。

因为 `--exclude-newer` 把 setuptools 也钉回 2021（没有 `build_editable`），所以不用
`pip install -e .`，而是普通安装拉依赖后把 flask 本身卸掉，再用 `PYTHONPATH=src`——
flask 是 src 布局，agent 改完源码立刻生效，无需重装。

验证环境是对的（gold patch + test_patch 应当全绿）：

```bash
cd runs/A/workspace
python3 -c "import json;d=json.load(open('../../instance.json'));open('/tmp/g.patch','w').write(d['patch']);open('/tmp/t.patch','w').write(d['test_patch'])"
git apply /tmp/g.patch /tmp/t.patch
PYTHONPATH=$PWD/src .venv/bin/python -m pytest -q tests/test_blueprints.py tests/test_basic.py
```

### 5. 跑

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
| `langfuse.txt` | 这次运行的 langfuse trace id 和 task run id |
| `memo-global/` | 全局 store（隔离的） |
| `workspace/.pi/memo/` | 项目 store |
| `workspace/.venv/` | 任务的 Python 环境（uv 按 instance 日期建） |
| `stderr.log` | pi 的错误输出 |
| `net-blocked-count.txt` | agent 试图外联被沙箱拒绝的次数 |

**在 langfuse 里找这次运行：**

`run.sh` 会显式加载 `@amaster.ai/pi-telemetry`（`-ne` 会跳过 pi package，所以要单独 `-e`），
凭据仍然从 `~/.pi/agent/settings.json` 的 `pi-telemetry` 段读，脚本不碰。

每次运行固定一个 trace id 并写进 `runs/<ARM>/langfuse.txt`：

```bash
cat runs/A/langfuse.txt
```

同时每个 span 带上 `task_run_id = agent-smoke/<ARM>/<instance_id>`，用它可以在 langfuse 里
把评测运行和日常使用分开筛。没装 telemetry 包时脚本会打印 `langfuse: skipped` 并照常跑完。

**主问题——它调了哪些工具：**

```bash
python3 -c "
import json,collections,sys
print(collections.Counter(json.loads(l)['toolName'] for l in open(sys.argv[1])
      if json.loads(l).get('type')=='tool_execution_start'))
" runs/A/trace.jsonl
```

触发条件修好之前，A 是 0、B 是 1。现在写入提醒作为最后一条消息注入，A 也会写——
四次运行里三次（NOTES.md 结论 3）。数字对不上先看 `dump_system_prompt.ts` 和注入位置。

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
| `run.sh` | 建截断历史的 workspace、隔离 store 与网络、跑 pi、抓 patch |
| `instance.json` | 当前这道题（已生成，可提交） |
| `NOTES.md` | 跑完的结论 |
| `repos/`、`runs/` | 本地产物，已 gitignore |
