# 第一轮：管道通了，但这个子集测不出东西

产物（`runs/`、`gold/`）已按要求清除，这里只留结论。重跑用
`./validate_gold.sh` + `./run_stream.sh`，代码没动。

## 结论 1：跨实例的记忆链路是通的

11 次运行（3 个 experience + 8 个 related，fan-out，`ARM=persistent`）：

| 项 | 结果 |
|---|---|
| experience 解出 | 3/3 |
| related 解出 | **0/8** |
| 写了记忆的运行 | 11/11 |
| related 主动调用 `memory_recall` | 8/8 |
| **召回到 experience 写下的那条** | **8/8** |

store 从 experience 传到 related、agent 按 id 主动召回、内容完整返回，全部成立。
**这是管道验证，不是效果验证。**

## 结论 2：这个子集测不出记忆有没有用

related **0/8**。指标钉在地板上，就算补上 `ARM=fresh` 基线也是 0 对 0，没有差可测。

而地板是**选子集时带进来的**，不是运气：

| 角色 | gold patch 行数 | 文件数 |
|---|---|---|
| experience | 10 / 2 / 23 | 全是 1 |
| related | 11 / 161 / 176 / 69 / 176 / 131 / 161 / 161 | 1–6 |

差一个数量级。experience 3/3 对 related 0/8 这个反差，几乎可以全部由难度解释，
不需要提到记忆。选簇时的标准是「一条经验喂多道题」（复用观测密度最高），
完全没看难度分布 —— SWE-ContextBench 的 related 集本来就比 experience 池难，
这个偏差被原样放大了。

唯一的例外是 `sympy__sympy-12426`：11 行单文件、1 个 F2P，和 experience 同量级，
它也失败了。这一道不能用难度解释。

**下一轮的前提**：`select_subset.py` 加一条 gold patch 规模上限重选，让指标先离开地板。
在这之前，补基线、加 seed、做 counterfactual replay 都没有意义。

## 结论 3：泄漏从系统装的包进来

主机上装着 sympy 1.14.0（`/usr/lib/python3.14/site-packages/sympy`），
它包含子集里每一道题的修复。8 次 related 里 **3 次读了它**（`16946` 触碰 56 次），
并且把方法写进了记忆：

```
consult-system-sympy-when-offline
  ...inspect /usr/lib/python3.14/site-packages/sympy before reconstructing
  behavior from scratch... The coding-agent `read` tool may deny this external
  path, but read-only shell searches or Python file reads work.
```

pi-sandbox 的默认 `denyRead` 是 `["/Users", "/home"]` —— 挡住了别的 checkout 和
uv 缓存，但对 `/usr` 只字未提。这和 git 历史泄漏（../agent-smoke NOTES 结论 2）、
网络泄漏（结论 4）是同一件事的第三种形态：**修复只要在 agent 够得着的地方，
它就不解题，改抄。**

已修：`lib.sh` 的 `write_sandbox_config` 按包名算出系统副本路径写进 `denyRead`，
不是硬编码 —— 任何「包同时装在系统里」的仓库都有这个问题。
用一次 30 秒探针验证过：`ls: cannot access ... No such file or directory`。

### 踩的坑：`/usr/lib64` 是 `/usr/lib` 的软链

两条 glob 命中同一个真实路径，bubblewrap 拿到两次「隐藏同一路径」的请求就**卡死**：
`trace.jsonl` 和 `stderr.log` 都是 0 字节，十分钟毫无动静。按 `realpath` 去重才好。

## 结论 4：agent 学到的多半是我们挖的坑

11 次运行写下的记忆里占多数的是这类：

```
legacy-sympy-xfail-pytest-noise
pytest-doctest-float-cmp-plugin-missing
use-stdlib-doctest-when-pytest-plugin-unavailable
consult-system-sympy-when-offline
```

全是关于 **harness** 的：pytest 版本对不上老 sympy、doctest 插件缺失、系统里有现代
sympy 可以抄。这是 ../agent-smoke NOTES 结论 6 原封不动地重演。

这是**效度问题，不是功效问题**：就算测出正收益，测的也是「记住怎么绕过我们挖的坑」，
而不是「记住领域知识」。修一个坑，agent 就换个坑学。

## 结论 5：venv 必须建在 workspace 里面

第一次跑 C1 时 venv 建在 workspace 外面（`$RUN/venv`），`PATH` 指过去也没用 ——
pi-sandbox 把 agent 的 bash 限制在 workspace 内（agent 的 HOME 也被放在那里），
一格之外的 venv 够不着，`python` 退回系统的 3.14，连 2017 年的 sympy 都 import 不了。
那次运行的 `memory_write` 就花在 `legacy-sympy-python314-compat` 上。

`../agent-smoke/run.sh` 把 venv 放在 `workspace/.venv` 正是这个原因。
gold gate 的 venv 仍在外面 —— 它在两个半场之间重建 workspace。

## 两个计数口径的坑（都自己踩了一遍）

**`recalled_entry_ids` 恒为空。** 我按 `id:` front matter 匹配，但那只存在于磁盘上的
`.md` 文件；工具输出是 `## <id>  [scope/kind]`（`src/tools/format.ts:5`）或
`[scope/kind] <id> — <title>`（同文件 :19）。结果 reuse 一列报 **0/8**，
而真实是 **8/8** —— 整个评测唯一要产出的数字，静默读成了 0。

**外联被拦的次数漏报。** `curl -s ... | python -c 'json.load(...)'` 会把 403 的响应体
吞掉，只留一个 JSON 解析 traceback；`uv` 说的是 "Failed to fetch"。按代理的措辞 grep
会把 3 次实际被拦的记成 0，读起来像「沙箱没开」。现在改成记「尝试次数 / 可识别的拒绝
次数」，两者不等就标出来人工看 —— 隔离的保证来自 `sandbox.json` 里的
`deniedDomains: ["*"]` 和开跑前的两条断言，这两个数字只是旁证。

## gold gate 的结果（重跑前可以直接用）

11/11 全部 gradeable，耗时 41 分钟（37 分钟在 pytest 里，每个实例跑两遍）。
`sympy__sympy-12427` 是异常值：只有 82 个 P2P 却每遍 321 秒，因为其中 56 个来自
`test_query.py`（sympy 1.0 的假设系统求解器）；`16342` 有 443 个反而只要 207 秒。

三个实例有 P2P 在 base 上就是红的，逐条排除（环境产物，抓不了回归）：

| instance | 排除的测试 |
|---|---|
| `sympy__sympy-12427` | `sympy/assumptions/tests/test_query.py::test_nan` |
| `sympy__sympy-16342` | `sympy/solvers/tests/test_solveset.py::test_invert_modular` |
| `sympy__sympy-16953` | `sympy/solvers/tests/test_solveset.py::test_invert_modular` |

这三条只能从 pre 那一遍得到：只跑 post 的话，看到测试红，无法区分「本来就红」和
「patch 改坏了」，想排除都不知道排除什么 —— 那 3 个实例会被误判为不可用。
