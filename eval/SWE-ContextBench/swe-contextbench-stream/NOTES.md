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

## 结论 6：`12426` 的失败不是能力问题，是题目没说全

用空 store 单跑 `sympy__sympy-12426`（11 行、单文件、1 个 F2P，和 experience 同量级）
做判别实验。结果 `resolved=False`，但补丁和 gold 只差一个索引。

gold：

```python
def _entry(self, i, j):
    eq = Eq(i, j)
    if eq is S.false:   return S.Zero
    elif eq is S.true:  return self.arg[i, i]
    return self.arg[i, j]*KroneckerDelta(i, j)
```

agent（18 次工具调用，90 秒）：

```python
def _entry(self, i, j):
    eq = Eq(i, j)
    if eq is S.true:    return self.arg[i, 0]
    elif eq is S.false: return S.Zero
    return self.arg[i, 0]*KroneckerDelta(i, j)
```

`Eq(i,j)` 三分支 + `KroneckerDelta(i,j)` 这个非显然的结构，**它自己推出来了，
和 gold 逐 token 对得上**（分支顺序不同但等价）。差的只有 `arg[i, 0]` vs `arg[i, i]`。

而那个差别来自 test_patch 里一处 issue **完全没提**的改动：

```diff
-x = MatrixSymbol('x', n, 1)      # 列向量
-D = DiagonalMatrix(x)
+X = MatrixSymbol('X', n, n)      # 方阵
+D = DiagonalMatrix(X)
     assert D[1, 2] == 0
-    assert D[1, 1] == x[1, 0]
+    assert D[1, 1] == X[1, 1]
```

题面只抱怨 `d[i,j]` 返回 0。它没说「顺便把被包裹参数从列向量改成方阵」。
agent 保留了原有的 `arg[i, 0]` —— 那正是改动前的代码和**改动前的测试**所断言的。

**关键：agent 结构上不可能验证。** SWE-bench 式评测不把 test_patch 给 agent，
F2P 测试在它的树里根本不存在。它跑了现有测试（3 passed / 122 passed），全绿，
于是收尾："Implemented the fix."。**它是自己判断做完了才停的，不是撞到预算上限**
（18 次调用，远低于其他 related 运行的 21–68 次）。

它甚至自己加了回归测试 —— 而 `grade.py` 会把测试文件还原，这是对的（agent 不能自己
定判分标准），但也意味着它的自检回路和真正的判分标准之间**结构性地隔着一层**。

### 对评测设计的影响

这一道说明：related 任务的 F2P 可能编码了 issue 文本里没有的要求。那么 resolve rate
测的就有一部分是「猜中了隐藏测试」，而不是「记忆用得好」。**这削弱的是下游指标本身**，
和有没有基线无关。

也顺带说明记忆在这道题上帮不上忙：C1 experience 写的 `symbolic-nested-kronecker-sums`
讲的正是 KroneckerDelta —— 而那部分 agent 本来就做对了。它不会告诉 agent
`arg` 该按方阵索引。这和上一轮「12426 召回了该条记忆、仍然 0/1」是一致的。

### 两条隔离措施都生效了

- `git ls-remote https://github.com/sympy/sympy.git 'refs/pull/12426/*'` —— 它确实去猜了
  PR 号（结论 8 说的那条路），被沙箱拦下（外联 1 次 / 拒 1 次）
- 系统 sympy 引用 **0 次**，`denyRead` 守住了

### 但这一道解释不了另外 7 道

那 7 道的 gold patch 是 131–176 行、最多 6 个文件。`12426` 的结论不能外推过去 ——
要判断它们，得看失败补丁离 gold 有多远，而那需要重跑。

## 结论 7：`16946` 是另一种失败 —— 规格不在题面里，agent 改了 4 行就宣布完成

同样用空 store 单跑。`resolved=False`，**F2P 0/6**（上一轮能读系统 sympy 时是 **4/6**）。

| | agent | gold |
|---|---|---|
| 补丁 | 1 文件 / **4 行** | 2 文件 / **69 行**（15 个 hunk） |

它做的全部是把两处类属性 `is_EmptySet` 改名成 `is_empty`。gold 要的是给
`Rationals`/`Naturals`/`Naturals0`/`Integers`/`ImageSet` 各加 `is_empty`、给
`Interval`/`ProductSet`/`Union`/`Complement`/`FiniteSet`/`UniversalSet` 算出
`is_empty`、外加 `is_EmptySet` 的弃用垫片。然后它收尾：

> Implemented the `is_EmptySet` → `is_empty` replacement. ... **74 passed, 4 expected failures**.

37 次工具调用、166 秒，**同样是自己判断做完了才停的**，不是撞预算。

### 4/6 → 0/6：上一轮那个最高的 related 分数主要是抄来的

这是本次最干净的一个数字。`denyRead` 装上之后，系统 sympy 引用 0 次，分数从 4/6 掉到 0/6。

### 隔离现在是完整的

37 次调用里约 15 次在找答案，每一条路都封死了：

```
urllib → api.github.com                          被拦
pip download / uv pip install sympy==1.5         被拦
find /usr/lib -path '*/sympy/sets/...'           denyRead 挡住
find /home/taot -path '*/sympy/sets/sets.py'     返回空
git tag --contains / fsck / ancestry-path / log --all -S   全空
find /home/taot/github/pi-memo -iname '*16946*'  只看见目录名
```

最后一条一度让人紧张 —— 它找到了 `runs/probe-16946-nomem` 这个目录，而 `instance.json`
（含 gold patch、test_patch、F2P 清单）就在里面。用探针确认过，**读不到**：

```
ls  .../runs/probe-16946-nomem/  →  workspace      （只有这一项）
head .../instance.json           →  No such file
head .../subset.json             →  No such file
```

bubblewrap 只把 workspace 挂进 namespace，同级文件在里面不存在；那个目录之所以可见，
只因为它是被挂载路径的父目录。默认的 `denyRead: ["/home"]` + `allowRead: ["."]`
恰好给出了正确结果。**结论：eval 自己的文件不是泄漏面。**

### 两道题的病因不同

| | `12426` | `16946` |
|---|---|---|
| 差距 | 一个索引 | 缺 95% |
| 病因 | 题面没提 fixture 语义变更 | 规格在被沙箱拦住的 GitHub 链接后面 |
| 判定 | **不是能力问题** | 题目缺陷 + agent 的**校准**问题（改 4 行就宣布完成） |

共同的结构性原因只有一个：**agent 看不到 F2P，而 issue 文本不足以推出契约。**
在 `12426` 上这代价是一个索引，在 `16946` 上是整套 API 设计。

## 结论 8：`16946` 的 0/6 是规格问题，不是能力问题 —— 给了测试就 6/6

`oracle-test` 诊断轨道（`run_instance.sh --oracle-test`：把官方 test_patch 打进 workspace，
prompt 末尾加一句「仓库里已有失败的测试，跑它们，让它们通过」）。同一道题、同一个 agent、
同样的空 store：

| | 默认（看不到测试） | `--oracle-test` |
|---|---|---|
| resolved | False | **True** |
| F2P | **0/6** | **6/6** |
| P2P | 150/150 | 150/150 |
| 补丁 | 1 文件 / 4 行 | **2 文件 / 64 行** |
| 工具调用 | 37 | **41** |
| 外联尝试 | 2（都被拦） | **0** |

gold 是 2 文件 / 69 行。agent 在 oracle 轨道下改的位置和 gold 几乎一一对应
（`Rationals`/`Naturals`/`Integers`/`ImageSet`/`Range` 加 `is_empty`，`Set` 基类加属性和
弃用垫片，`Interval`/`EmptySet`/`UniversalSet`/`FiniteSet` 各自算 `is_empty`）。

**三个变量因此分离干净：**

- **能力**：够。给了规格就做得出来，补丁规模和形状都对得上 gold。
- **预算**：够。41 次调用 vs 37 次，几乎没多花 —— 不是没跑完。
- **规格**：这就是全部缺口。0/6 → 6/6，唯一的差别是规格可见。

还有一个旁证：默认轨道下它 2 次尝试外联、约 15 次调用在翻 git 历史和系统目录找答案；
oracle 轨道下**外联 0 次**。**那些找答案的行为不是投机，是缺规格的症状。**

### 这对评测设计意味着什么

好消息：信息缺口真实存在且很大（0/6 → 6/6）。**这正是记忆原则上能填的那种缺口。**

坏消息：得先确认「经验题里真的含有待测题需要的那份知识」。C2 的 experience 是
`16988`（FiniteSet 与 Symbol 的交集），和 `16946` 要的 `is_empty` API 契约是两回事 ——
它写下的还是 harness lore（`legacy-sympy-xfail-pytest-noise`）。**关联表里的「引用关系」
不等于「共享知识」。** 这是继泄漏（118 对同 PR）和时序（只有 31% 经验更早）之后，
关联表的第三个问题，而且没法用元数据筛掉，只能看内容。

### `--oracle-test` 不进主结果

它量的是上限。默认轨道绝不能给测试：测试就是判分标准，交出去等于把任务从「修好这个 bug」
变成「让这几个断言通过」；对这个评测更致命的是，**它会删掉记忆本该填的那个信息缺口** ——
`fresh` 和 `persistent` 两臂会因为一个和记忆无关的原因得到同样的分数。

## 结论 9：关联表还有两个缺陷，前两条筛选都没盖住

`screen_pairs.py` 在那 32 对 clean pair 上又找出两种，**10 对中招**：

**一、related 的题面和 experience 的题面逐字相同。**
`psf__requests-3362 → 3359` 就是这样：PR 号不同、日期差三个月，但那是同一个 bug 报告的
两次修复尝试，改的是 `requests/utils.py` 里**同一段代码的相反方向** —— experience 给
`stream_decode_response_unicode` 加 `apparent_encoding` 兜底，related 把那个分支整个删掉、
把检查挪进 `iter_content`。把这种"经验"交出去，等于把答案所在的那几行圈出来。
`xarray 3364 → 508`、`matplotlib 22711 → 22686` 同病。

**二、同一个 experience 下的两道 related，gold patch 逐字节相同。**
两道"不同"的题其实是同一道，跑两遍只是把同一个观测数了两次。

### 我原来那个子集因此报废

跑过的 8 道 related 里：

```
16342 ≡ 16953   gold patch 逐字节相同   （实测确认）
21309 ≡ 9384    gold patch 逐字节相同   （实测确认）
```

**实际只有 6 道不同的题，不是 8 道。** 加上结论 2 的地板效应和结论 8 的知识不重合
（C3 三对的共享文件数和共享符号数都是 **0**），这个子集三条都占了。

### 四条筛选之后，Lite 干净集基本被抽干

32 对 → 剔掉 10 对 → 剩下的里面，**只有 `scikit-learn 10949 → {12622, 15093}` 还是
一对多**（两道 related 的 gold patch 分别是 8 行和 6 行），其余全是 1:1。
1:1 不是不能用，只是每个观测要花两次 agent 运行。

### 排名第一的候选：`sympy 14774 → 19235`

```python
# experience 14774: sympy/printing/latex.py::_print_Function
- inv_trig_table = ["asin", "acos", "atan", "acot"]
+ inv_trig_table = ["asin", "acos", "atan", "acsc", "asec", "acot"]

# related 19235（696 天后）: 同一文件、同一函数、同一个列表
+ inv_trig_table = [..., "asinh", "acosh", "atanh", "acsch", "asech", "acoth"]
```

related 补丁 7 行、单文件，共享文件和共享符号都命中，题面还明写 "Follows on from gh-14774"。
记忆里能带走的是**位置和机制**，「加哪几个函数」来自题面 —— 这不是泄漏，是可迁移知识该有的样子。
它的 `spec_behind_url` 是误报：那个 URL 是 sympy PR 模板里讲 issue 自动关闭约定的样板文字。

需要注意的反向风险：这道题可能**太好做**（`rg inv_trig_style` 一条命令就能定位），
于是从地板跳到天花板，同样没有动态范围。得实测。
