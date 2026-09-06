# swe-contextbench-stream：一条经验，几道后续题

`../agent-smoke/` 回答的是「agent 会不会写记忆」。这里问的是下一个问题：
**上一道题写下的记忆，在下一道题里还在不在、被不被读、这道题解没解出来。**

跑法是 SWE-ContextBench 自己的结构：经验池里的一道题（experience）先解，它留下的
memory store 原样交给引用了它的几道待测题（related），每道题都用官方 `FAIL_TO_PASS` /
`PASS_TO_PASS` 判分。

**只有一条臂。** 框架里有 `ARM=fresh`（每个实例从空 store 开始）作为基线开关，但本轮没跑。
因此结果能说的是「pipeline 通了、agent 的记忆读写长什么样、带记忆时解出了几道」，
**不能**说「记忆有净收益」——那需要基线。

**不加 nudge。** prompt 是 `../agent-smoke/prompt.py` arm A 的原文。扩展自带的
`CLOSING_NUDGE`（`src/store/index-file.ts`）是产品行为，留着；再从评测这边加一句，
测的就是 harness 而不是 pi-memo 了。

## 前置条件

| 需要 | 检查 |
|---|---|
| pi 已安装并配好鉴权 | `pi --version` |
| pi-sandbox（网络隔离） | `ls ~/.pi/agent/npm/node_modules/pi-sandbox/index.ts` |
| ripgrep（缺了沙箱静默关闭） | `command -v rg` |
| uv / python3 / jq / git | `uv --version` |
| 读 parquet 的 venv | `ls ../swe-contextbench/.venv/bin/python` |
| sympy 克隆 | `git clone https://github.com/sympy/sympy repos/sympy` |

`repos/`、`gold/`、`runs/` 都在 `.gitignore` 里。`subset.json` 是提交的——它是这次评测
到底跑了哪 11 个实例的凭据。

## 子集：sympy 三个簇，11 个实例

关系表 362 对里有 118 对两边 `pr_url` 相同：SWE-ContextBench 按 **issue** 建 instance，
而一个 PR 常常一次关掉多个 issue，于是同一次改动裂成「待测题」和「历史经验」两条，
其中 36 对 gold patch 逐字节相同 —— 把这种「经验」喂给 agent 等于递答案。
另外关系表是**引用图不是时间线**，只有约 31% 的配对经验确实更早。

`select_subset.py` 因此固定两条筛选，Lite 的 102 对 → **32 对**：

```python
related_pr_url != experience_pr_url          # 不是同一个 PR
related.created_at > experience.created_at   # 经验确实先发生
```

sympy 占其中 12 对，且纯 Python、只依赖 mpmath。再取「一条经验喂多道题」的三个簇——
1:1 的配对要花两次 agent 运行才换来一次观测：

| 簇 | experience | related | version | gap |
|---|---|---|---|---|
| C1 | `sympy__sympy-12419` | `12426`, `12427` | 1.0 | 1 / 5 天 |
| C2 | `sympy__sympy-16988` | `16342`, `16946`, `16953` | 1.5 | 76–81 天 |
| C3 | `sympy__sympy-21055` | `21203`, `21309`, `9384` | 1.8 → 1.9 | 23–37 天 |

同簇的 related 任务**fan-out**：每道都从 experience 跑完那一刻的同一份 store 快照出发，
互不影响。一条经验因此拿到 2–3 次独立观测；串行会让第三道题分不清收益来自哪条记忆。

## 跑

```bash
# 1. 冻结子集（只需一次，结果已提交）
../swe-contextbench/.venv/bin/python select_subset.py

# 2. gold gate：证明判分口径能区分解出和没解出。不花 LLM 额度，必须先跑。
./validate_gold.sh

# 3. 评测
./run_stream.sh            # 三个簇；或 ./run_stream.sh C1
```

`run_stream.sh` 开头会检查 `gold/<id>/gate.json`，gate 没过的实例直接拒跑。

产物在 `runs/<run-id>/<cluster>/{experience,related-<id>}/`：`trace.jsonl`、`patch.diff`、
`grade.json`、`metrics.json`、`memo-project-after/`、`prompt.txt`、`stderr.log`、
`net-blocked-count.txt`，顶层是 `manifest.txt`、`results.json`、`report.md`。

## gold gate 在验什么

对每个实例建一次 workspace，两个方向各测一遍：

- **不打 gold patch**：所有 `FAIL_TO_PASS` 必须 **fail**。一个在 base 上就通过的测试，
  永远区分不了任何东西。
- **打上 gold patch**：`FAIL_TO_PASS` 和 `PASS_TO_PASS` 必须**全 pass**。

任一半不过的实例就是这个 harness 判不了的，踢出子集（原因记进 NOTES.md）。

## 几处不显然的地方

**测试 id 有两种写法。** related 实例用 pytest node id
（`sympy/sets/tests/test_sets.py::test_imageset`），三个 experience 实例用裸函数名
（`test_Identity`，SWE-bench sympy runner 的写法）。裸名的实例恰好都只碰一个测试文件，
`grade.py` 按那个文件解析；解析不出来是错误，不是静默跳过。

**不安装 sympy。** sympy 是 flat layout，包就在仓库根，所以只装 mpmath 并把
`PYTHONPATH` 指向 workspace——agent 的改动立刻生效，不需要 flask 那套装完再卸载的绕法。

**`--exclude-newer` 放过 setuptools/wheel。** mpmath 0.19 没有 wheel，而 2017 年的
setuptools 没有 PEP 517 backend，sdist 根本构建不了。日期钉的是运行期依赖的版本，
不是构建后端。

**pytest 不按实例日期钉。** 2017 年的 pytest 装不进 uv 能取到的解释器。用现代 pytest 跑
老 sympy 行不行，由 gold gate 说了算——目前三个 version 家族都通过。

**patch 口径。** 候选 patch 排除 `.pi/`（pi-memo 自己的输出）和官方 test_patch 涉及的
测试文件；`grade.py` 判分前也会把测试文件 `git checkout` 回去。agent-smoke 里两个 arm
都顺手改过测试文件（NOTES 结论 3、结论 8）。

**网络全封。** `instance_id` 就是 PR 号，`git ls-remote ... refs/pull/<id>/head` 一条命令
就能捞到答案（结论 8）。`deniedDomains: ["*"]`，每次运行数一遍被拦的次数；
**0 次要单独查**——可能是 agent 没试，也可能是缺 `rg` 导致沙箱静默关闭。

**workspace 是历史截断，不是合成 commit。** 给到 base 为止的真实历史，之后的一概没有。
四条断言每次都查：`HEAD == base_commit`、`.git/shallow` 存在、`rev-list --all --not HEAD`
为空、没有 remote。细节和踩过的坑见 `lib.sh` 的注释与 `../agent-smoke/NOTES.md`。

**真实 `~/.pi/memo` 不会被碰。** global store 由 `PI_MEMO_HOME` 指向 run 目录，
project store 在一次性 workspace 里。

## 文件

| 文件 | 作用 |
|---|---|
| `select_subset.py` → `subset.json` | 按上面两条口径重算并冻结子集 |
| `instance.py` | 从 `subset.json` 读一个实例（也可命令行取单个字段） |
| `lib.sh` | workspace 构建、venv 构建、沙箱配置 |
| `validate_gold.sh` | gold gate |
| `prompt.py` | 任务 prompt（arm A 原文，不加 nudge） |
| `run_instance.sh` | 单实例：建环境 → 装入 store → 跑 pi → 抽 patch → 判分 |
| `grade.py` | 还原测试文件、打 test_patch、跑 F2P/P2P、逐 node id 判定 |
| `trace_metrics.py` | 从 trace 抽工具调用与 memory_* 行为 |
| `run_stream.sh` | 编排：experience → 快照 → fan out related |
| `report.py` | 汇总 → `results.json` + `report.md` |
