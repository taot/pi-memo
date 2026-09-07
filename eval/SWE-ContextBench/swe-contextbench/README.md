# SWE-ContextBench 本地副本

来自 [`jiayuanz3/SWEContextBench`](https://huggingface.co/datasets/jiayuanz3/SWEContextBench)
（论文 [arXiv:2602.08316](https://arxiv.org/abs/2602.08316)，MIT license）。

## 启动 notebook

```bash
cd eval/swe-contextbench
.venv/bin/python -m jupyter lab explore_swe_contextbench.ipynb
```

`.venv` 里已装好 pandas / pyarrow / matplotlib / jupyterlab。
notebook 已经执行过一遍，直接打开就能看到所有输出。

## 文件

| 文件 | 内容 |
|---|---|
| `data/SWEContextBench_Experience.parquet` | 1100 条经验池任务（base tasks） |
| `data/SWEContextBench_Related.parquet` | 376 条待测任务（related tasks） |
| `data/SWEContextBench_Relationship.parquet` | related ↔ experience 的关联表 |
| `data/SWEContextBench_Lite_Experience.parquet` | 经验池的 300 条子集 |
| `data/SWEContextBench_Related_Lite.parquet` | 待测任务的 99 条子集 |
| `explore_swe_contextbench.ipynb` | 数据探索 notebook |
| `_gen_notebook.py` | 生成上面那个 notebook 的脚本 |

## 用数据前要知道的三件事

1. `FAIL_TO_PASS` / `PASS_TO_PASS` **不都是合法 JSON** —— 约 1/4 的行是 Python 或
   numpy 的 `repr()`（numpy 那种元素间没有逗号，`ast.literal_eval` 会解析错）。
   notebook 里的 `parse_tests()` 做了兼容。
2. `instance_id` **有重复行，且重复行内容不完全相同**（experience 1100 行 / 1007 唯一，
   related 376 行 / 357 唯一）。直接 `set_index` 再 `.loc` 会拿到 DataFrame。
3. 关系表里的 "prior experience" 是**引用关系**不是**时间先后** —— 只有约 31% 的配对
   experience 确实更早，中位时间差为 0 天。

## 跑评测

本目录只有数据。评测代码和 Docker 镜像见：
- https://github.com/jiayuanz3/SWEContextBench
- https://hub.docker.com/r/jiayuanz3/swecontextbench/tags
