import json, sys

cells = []

def md(src):
    cells.append({"cell_type": "markdown", "metadata": {},
                  "source": src.strip("\n").splitlines(keepends=True)})

def code(src):
    cells.append({"cell_type": "code", "execution_count": None, "metadata": {},
                  "outputs": [], "source": src.strip("\n").splitlines(keepends=True)})


md(r"""
# SWE-ContextBench 数据探索

- 论文：[SWE Context Bench: A Benchmark for Context Learning in Coding](https://arxiv.org/abs/2602.08316) (arXiv:2602.08316)
- 数据集：[`jiayuanz3/SWEContextBench`](https://huggingface.co/datasets/jiayuanz3/SWEContextBench)
- 评测代码：https://github.com/jiayuanz3/SWEContextBench

## 这个 benchmark 在测什么

普通的 SWE-bench 把每个 issue 当成**独立**任务。SWE-ContextBench 的出发点是：真实项目里的 issue 是**有关联**的 —— 同一个 repo 里，一个新 PR 常常引用、依赖之前的某个 PR。

于是数据被拆成两半：

| 文件 | 行数 | 角色 |
|---|---|---|
| `SWEContextBench_Experience.parquet` | 1100 | **经验池**（base tasks）。先跑这些，把解题过程沉淀成"经验"（摘要 / 索引 / memory）。 |
| `SWEContextBench_Related.parquet` | 376 | **待测任务**（related tasks）。跑这些时允许 agent 去经验池里检索。 |
| `SWEContextBench_Relationship.parquet` | 376 | 关系表：哪个 related 任务对应哪个 experience 任务。 |
| `SWEContextBench_Lite_Experience.parquet` | 300 | 经验池的小规模子集。 |
| `SWEContextBench_Related_Lite.parquet` | 99 | 待测任务的小规模子集。 |

评测的不只是"解没解对"，还有**效率**：用了对的历史经验，应该更准 + 更省 token + 更快；而塞入无关的上下文则应该没有收益甚至变差。

单个 task instance 的字段沿用 SWE-bench 惯例，完全兼容。

> 本 notebook 只做数据理解，不跑评测。跑评测见最后一节。
""")

md("## 0. 环境")

code(r"""
import ast
import json
import re
import textwrap
from collections import Counter
from pathlib import Path

import pandas as pd

pd.set_option("display.max_colwidth", 120)

DATA = Path.cwd() / "data"      # parquet 文件在 notebook 同级的 data/ 子目录下
assert DATA.is_dir(), f"找不到 {DATA}，请在 notebook 所在目录启动 jupyter"

sorted(p.name for p in DATA.glob("*.parquet"))
""")

md("## 1. 载入五张表")

code(r"""
experience      = pd.read_parquet(DATA / "SWEContextBench_Experience.parquet")
related         = pd.read_parquet(DATA / "SWEContextBench_Related.parquet")
relationship    = pd.read_parquet(DATA / "SWEContextBench_Relationship.parquet")
experience_lite = pd.read_parquet(DATA / "SWEContextBench_Lite_Experience.parquet")
related_lite    = pd.read_parquet(DATA / "SWEContextBench_Related_Lite.parquet")

for name, df in [("experience", experience), ("related", related),
                 ("relationship", relationship),
                 ("experience_lite", experience_lite), ("related_lite", related_lite)]:
    print(f"{name:<16} {df.shape[0]:>5} rows x {df.shape[1]} cols")

print()
print("任务表字段:", list(experience.columns))
print("关系表字段:", list(relationship.columns))
""")

md(r"""
## 2. 一个 task instance 长什么样

先只看结构 —— 每个字段的类型和长度，不打印正文。
""")

code(r"""
row = related.iloc[0]

for col in related.columns:
    v = row[col]
    s = str(v)
    preview = s if len(s) <= 70 else s[:67].replace("\n", " ") + "..."
    print(f"{col:<25} {type(v).__name__:<8} len={len(s):>7}  {preview}")
""")

md(r"""
### ⚠️ 坑一：`FAIL_TO_PASS` / `PASS_TO_PASS` 的格式不统一

数据卡说这两个字段是 "a json list of strings"。**实际上只有约 3/4 的行是合法 JSON。**
其余是 Python `repr()` 出来的字符串（单引号），其中一部分还是 **numpy 数组的 repr** —— 元素之间没有逗号，只有换行：

```
"['a.b.TestX#testDiv'\n 'a.b.TestX#testQuotient']"
```

这种连 `ast.literal_eval` 都会解析错（被当成隐式字符串拼接，两个测试名会粘成一个）。
所以下面用一个三级回退的解析器，后面所有涉及这两个字段的地方都走它。
""")

code(r"""
QUOTED = re.compile("'([^']*)'|\"([^\"]*)\"")


def parse_tests(v):
    '''把 FAIL_TO_PASS / PASS_TO_PASS 解析成 list[str]。兼容 JSON / Python repr / numpy repr。'''
    if v is None:
        return []
    if isinstance(v, (list, tuple)):
        return [str(x) for x in v]
    s = str(v).strip()
    if not s:
        return []

    # 1) 标准 JSON
    try:
        out = json.loads(s)
        if isinstance(out, list):
            return [str(x) for x in out]
    except Exception:
        pass

    # 2) Python 字面量（单引号 list）。但 numpy repr 缺逗号会被误解析成字符串拼接，
    #    用「引号片段数」和「解析出的元素数」是否一致来识别这种情况。
    try:
        out = ast.literal_eval(s)
        if isinstance(out, (list, tuple)) and all(isinstance(x, str) for x in out):
            if len(out) == len(QUOTED.findall(s)):
                return list(out)
    except Exception:
        pass

    # 3) 兜底：直接抠出所有被引号包住的片段
    return [a or b for a, b in QUOTED.findall(s)]


def is_json_list(v):
    try:
        return isinstance(json.loads(str(v)), list)
    except Exception:
        return False


for df, name in [(experience, "experience"), (related, "related")]:
    for col in ["FAIL_TO_PASS", "PASS_TO_PASS"]:
        n = sum(1 for v in df[col] if is_json_list(v))
        print(f"{name:<12} {col:<14} {n:>5}/{len(df):<5} 行是合法 JSON  (其余 {len(df)-n} 行是 repr)")

print()
bad = next(v for v in experience["FAIL_TO_PASS"] if not is_json_list(v))
print("一个非 JSON 的例子:")
print("  raw    :", repr(bad)[:170])
print("  解析后 :", parse_tests(bad))
""")

md(r"""
### ⚠️ 坑二：`instance_id` 有重复行

`Experience` 和 `Related` 两张表里都有重复的 `instance_id`。
如果直接 `set_index("instance_id")` 再 `.loc[...]`，取出来的会是 DataFrame 而不是 Series，
后续代码会莫名其妙地炸。**建索引前先 `drop_duplicates`。**
""")

code(r"""
for name, df in [("experience", experience), ("related", related),
                 ("experience_lite", experience_lite), ("related_lite", related_lite)]:
    n, u = len(df), df["instance_id"].nunique()
    print(f"{name:<16} {n:>5} 行 / {u:>5} 个唯一 id   (重复 {n - u})")

dup_ids = related["instance_id"][related["instance_id"].duplicated()].unique()
print()
print("related 中重复的 id 示例:", list(dup_ids[:5]))

d = related[related["instance_id"].isin(dup_ids)]
print("这些重复行在所有列上也完全相同:", len(d.drop_duplicates()) == d["instance_id"].nunique())

# 不完全相同的话，差在哪些列？
g = d.groupby("instance_id")
diff_cols = [c for c in d.columns if (g[c].nunique(dropna=False) > 1).any()]
print("同一个 id 的不同行，在这些列上取值不同:", diff_cols)
""")

md(r"""
注意：同一个 `instance_id` 的多行**内容并不完全相同**。所以 `drop_duplicates(subset="instance_id")`
是"保留第一条"，不是"去掉冗余"。如果你要做严肃的评测，得先搞清楚哪一条才是权威版本
（可以去对照上游的 SWE-bench Lite / Verified / Multilingual）。本 notebook 只为浏览方便，取第一条。
""")

md(r"""
### 2.1 完整打印一个 instance

下面的 helper 把一个 task 的每个字段完整展开。这是理解数据最直接的方式 ——
一个 instance 本质上就是：

> **在 `base_commit` 这个提交上，给你一段 issue 描述（`problem_statement`），
> 要你写出 `patch`，使得 `FAIL_TO_PASS` 里的测试从红变绿，
> 同时 `PASS_TO_PASS` 里的测试保持绿。**

`test_patch` 是官方提供的测试代码（评测时会强制打上，防止 agent 改测试作弊），
`hints_text` 是 PR 提交前 issue 下面的讨论。
""")

code(r"""
def show_instance(row, max_chars=2500, fields=None):
    '''完整展示一个 task instance。max_chars=None 表示不截断。'''
    for col in (fields or list(row.index)):
        v = row[col]
        print("=" * 100)
        print(f"### {col}")
        print("=" * 100)
        if col in ("FAIL_TO_PASS", "PASS_TO_PASS"):
            tests = parse_tests(v)
            print(f"({len(tests)} 个测试)")
            for t in tests[:20]:
                print("  -", t)
            if len(tests) > 20:
                print(f"  ... 还有 {len(tests) - 20} 个")
        else:
            s = str(v)
            if max_chars is not None and len(s) > max_chars:
                print(s[:max_chars])
                print(f"\n... [截断，本字段共 {len(s)} 字符]")
            else:
                print(s)
        print()


show_instance(row)
""")

md(r"""
## 3. 关系表：related 任务 ↔ experience 任务

这是 SWE-ContextBench 相对 SWE-bench 唯一新增的东西，也是整个 benchmark 的核心。
""")

code(r"""
relationship.head(5)
""")

code(r"""
fanout = relationship.groupby("related_instance_id")["experience_instance_id"].nunique()

print("关系表行数:", len(relationship))
print("其中 related 任务（去重）:", relationship["related_instance_id"].nunique())
print("被引用的 experience 任务（去重）:", relationship["experience_instance_id"].nunique())
print()
print("每个 related 任务关联多少个 experience 任务:")
print(fanout.value_counts().sort_index().to_string())
print()
print("一个 experience 任务最多被几个 related 任务引用:",
      relationship.groupby("experience_instance_id")["related_instance_id"].nunique().max())

missing_e = set(relationship["experience_instance_id"]) - set(experience["instance_id"])
missing_r = set(relationship["related_instance_id"]) - set(related["instance_id"])
print()
print("关系表引用但不在 experience 池里的 id 数:", len(missing_e))
print("关系表引用但不在 related  表里的 id 数:", len(missing_r))
""")

md(r"""
### 3.1 并排看一对：新任务 + 它的历史经验

这一格是全篇最值得看的：同一个 repo 里，一个新 issue 和它所参考的旧 issue 摆在一起。
你能直观看到"上下文复用"到底指什么 —— 二者往往改的是同一批文件、同一个模块。
""")

code(r"""
# 注意坑二：建索引前先去重
exp_by_id = experience.drop_duplicates(subset="instance_id").set_index("instance_id")
rel_by_id = related.drop_duplicates(subset="instance_id").set_index("instance_id")


def patched_files(patch):
    '''从 unified diff 里抽出被改动的文件路径。'''
    out = []
    for line in str(patch).splitlines():
        if line.startswith("--- a/") or line.startswith("+++ b/"):
            p = line[6:].strip()
            if p not in out and p != "/dev/null":
                out.append(p)
    return out


def show_pair(related_instance_id, n_chars=1200):
    links = relationship[relationship["related_instance_id"] == related_instance_id]
    r = rel_by_id.loc[related_instance_id]

    print("#" * 100)
    print(f"# [NEW TASK] {related_instance_id}    repo={r['repo']}    created={r['created_at']}")
    print("#" * 100)
    print(links.iloc[0]["related_issue_url"], "|", links.iloc[0]["related_pr_url"])
    print()
    print(textwrap.shorten(r["problem_statement"].replace("\n", " "), n_chars, placeholder=" ..."))
    print("\n--- gold patch 触及的文件 ---")
    for f in patched_files(r["patch"]):
        print("   ", f)

    for _, link in links.iterrows():
        eid = link["experience_instance_id"]
        print()
        print("#" * 100)
        print(f"#   ^-- [PRIOR EXPERIENCE] {eid}")
        print("#" * 100)
        print(link["experience_issue_url"], "|", link["experience_pr_url"])
        if eid not in exp_by_id.index:
            print("   (不在经验池中)")
            continue
        e = exp_by_id.loc[eid]
        print("created =", e["created_at"])
        print()
        print(textwrap.shorten(e["problem_statement"].replace("\n", " "), n_chars, placeholder=" ..."))
        print("\n--- gold patch 触及的文件 ---")
        for f in patched_files(e["patch"]):
            print("   ", f)


show_pair(related.iloc[0]["instance_id"])
""")

code(r"""
# 挑一个「新任务和旧任务改了重叠文件」的例子，对比更明显
def overlap_score(rid):
    if rid not in rel_by_id.index:
        return 0
    new_files = set(patched_files(rel_by_id.loc[rid]["patch"]))
    links = relationship[relationship["related_instance_id"] == rid]
    best = 0
    for eid in links["experience_instance_id"]:
        if eid in exp_by_id.index:
            best = max(best, len(new_files & set(patched_files(exp_by_id.loc[eid]["patch"]))))
    return best


scores = {rid: overlap_score(rid) for rid in related["instance_id"].unique()}
ranked = sorted(scores.items(), key=lambda kv: -kv[1])

n_overlap = sum(1 for _, sc in ranked if sc > 0)
print(f"{n_overlap}/{len(ranked)} 个 related 任务与其历史经验改动了至少一个相同文件"
      f"  ({n_overlap / len(ranked):.0%})")
print()
print("文件重叠度最高的 10 个:")
for rid, sc in ranked[:10]:
    print(f"  {sc:>2} 个共同文件   {rid}")
""")

code(r"""
show_pair(ranked[0][0])
""")

md("## 4. 数据集全貌统计")

code(r"""
print("experience 池覆盖 repo 数:", experience["repo"].nunique())
print("related  覆盖 repo 数:", related["repo"].nunique())
print("合计唯一 repo 数:", pd.concat([experience["repo"], related["repo"]]).nunique())
print()
print("related 任务最多的 15 个 repo:")
print(related["repo"].value_counts().head(15).to_string())
""")

code(r"""
# 数据集没有显式的 language 列，用 patch 里的文件后缀近似推断
EXT2LANG = {
    ".py": "Python", ".js": "JavaScript", ".jsx": "JavaScript",
    ".ts": "TypeScript", ".tsx": "TypeScript", ".go": "Go", ".java": "Java",
    ".rb": "Ruby", ".rs": "Rust", ".c": "C", ".h": "C", ".cc": "C++",
    ".cpp": "C++", ".hpp": "C++", ".cs": "C#", ".php": "PHP",
    ".scala": "Scala", ".kt": "Kotlin",
}


def langs_of(patch):
    out = set()
    for f in patched_files(patch):
        for ext, lang in EXT2LANG.items():
            if f.endswith(ext):
                out.add(lang)
    return out


for df, name in [(experience, "experience"), (related, "related")]:
    c = Counter()
    for p in df["patch"]:
        c.update(langs_of(p))
    print(f"--- {name} 语言分布（按 patch 文件后缀推断，一个任务可能计入多种语言）---")
    for lang, n in c.most_common():
        print(f"  {lang:<12} {n}")
    print()
""")

code(r"""
# 任务"体量"：问题描述长度、patch 大小、测试数量
def size_table(df, label):
    t = pd.DataFrame({
        "problem_chars": df["problem_statement"].str.len(),
        "patch_chars": df["patch"].str.len(),
        "patch_files": df["patch"].map(lambda p: len(patched_files(p))),
        "test_patch_chars": df["test_patch"].str.len(),
        "n_fail_to_pass": df["FAIL_TO_PASS"].map(lambda s: len(parse_tests(s))),
        "n_pass_to_pass": df["PASS_TO_PASS"].map(lambda s: len(parse_tests(s))),
        "hints_chars": df["hints_text"].fillna("").str.len(),
    })
    print(f"--- {label} ---")
    print(t.describe().T[["mean", "50%", "min", "max"]].round(1).to_string())
    print()
    return t


t_exp = size_table(experience, "experience (1100 行)")
t_rel = size_table(related, "related (376 行)")
""")

code(r"""
t_rel[["problem_chars", "patch_chars", "patch_files", "n_fail_to_pass"]].hist(
    bins=40, figsize=(11, 7), log=True
);
""")

code(r"""
# 时间关系：related 任务是否确实晚于它引用的 experience 任务？
pairs = (relationship
         .merge(related.drop_duplicates("instance_id")[["instance_id", "created_at"]]
                .rename(columns={"instance_id": "related_instance_id", "created_at": "related_at"}),
                on="related_instance_id", how="left")
         .merge(experience.drop_duplicates("instance_id")[["instance_id", "created_at"]]
                .rename(columns={"instance_id": "experience_instance_id", "created_at": "experience_at"}),
                on="experience_instance_id", how="left"))

pairs["related_at"] = pd.to_datetime(pairs["related_at"], errors="coerce", utc=True)
pairs["experience_at"] = pd.to_datetime(pairs["experience_at"], errors="coerce", utc=True)
pairs["gap_days"] = (pairs["related_at"] - pairs["experience_at"]).dt.days

ok = pairs["gap_days"].notna()
print(f"可比较的配对: {ok.sum()}/{len(pairs)}")
print("related 晚于 experience 的比例:", f"{(pairs.loc[ok, 'gap_days'] > 0).mean():.1%}")
print()
print("时间间隔（天）:")
print(pairs["gap_days"].describe().round(1).to_string())
""")

md(r"""
**这个结果有点反直觉，值得留意。**

只有约 31% 的配对里 related 任务的 `created_at` 晚于它的 experience 任务，中位间隔是 0 天。
也就是说，这里的 "prior experience" 指的是 **issue/PR 之间的引用与依赖关系**（谁 reference 了谁），
而**不是**"时间上更早"。两个 issue 常常是同期开的，甚至 experience 那条更晚。

再加上还有 111/376 个配对因为 `created_at` 缺失而无法比较。

如果你要用这个 benchmark 论证"复用历史经验"，需要意识到：它并没有强制一条时间上的因果方向，
所以严格来说存在从"未来"往"过去"泄漏信息的可能。想避免的话，可以用上面的 `gap_days > 0`
自己筛一个时序干净的子集。
""")

md(r"""
## 5. Lite 子集

用来快速实验。确认它就是全量集的子集。
""")

code(r"""
print("experience_lite ⊆ experience :",
      set(experience_lite["instance_id"]).issubset(set(experience["instance_id"])))
print("related_lite    ⊆ related    :",
      set(related_lite["instance_id"]).issubset(set(related["instance_id"])))
print()
print("related_lite 覆盖 repo 数:", related_lite["repo"].nunique())
print(related_lite["repo"].value_counts().head(10).to_string())

# lite 的 related 任务，其经验是否也都在 lite 经验池里？
lite_links = relationship[relationship["related_instance_id"].isin(related_lite["instance_id"])]
covered = set(lite_links["experience_instance_id"]) <= set(experience_lite["instance_id"])
print()
print("related_lite 所需的 experience 全部在 experience_lite 中:", covered)
if not covered:
    n_missing = len(set(lite_links["experience_instance_id"]) - set(experience_lite["instance_id"]))
    print(f"  -> 有 {n_missing} 个所需 experience 只存在于完整经验池中")
""")

md(r"""
## 6. 自己挑一个来看

改下面的 `INSTANCE_ID` 就能看任意一条。
""")

code(r"""
INSTANCE_ID = related["instance_id"].iloc[3]   # 换成任意 id

src = related if INSTANCE_ID in set(related["instance_id"]) else experience
show_instance(src.drop_duplicates("instance_id").set_index("instance_id").loc[INSTANCE_ID],
              max_chars=4000)
""")

md(r"""
---

## 附：怎么真正跑评测

本 notebook 只做数据理解。要实际跑 agent 并判分：

- 评测代码：https://github.com/jiayuanz3/SWEContextBench
- 预构建 Docker 镜像（376 个 related 任务）：https://hub.docker.com/r/jiayuanz3/swecontextbench/tags

判分逻辑与 SWE-bench 一致：在 `base_commit` 上应用你生成的 patch，再强制打上官方
`test_patch`，然后跑测试 —— 要求 `FAIL_TO_PASS` 全部通过，且 `PASS_TO_PASS` 不出现回归。

本 benchmark 特有的部分是**两阶段**：先在 experience 池上跑一遍并把过程存成某种可检索的形式，
再在 related 任务上跑，比较不同的上下文策略（无上下文 / 全量塞入 / 检索 / 给定 oracle 经验）
在准确率、耗时、token 消耗上的差异。
""")

nb = {
    "cells": cells,
    "metadata": {
        "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
        "language_info": {"name": "python", "version": "3.12"},
    },
    "nbformat": 4,
    "nbformat_minor": 5,
}

with open(sys.argv[1], "w") as f:
    json.dump(nb, f, indent=1, ensure_ascii=False)
print("wrote", sys.argv[1], len(cells), "cells")
