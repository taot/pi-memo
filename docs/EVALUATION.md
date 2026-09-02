# pi-memo evaluation framework

## 1. 结论：以四个现有 benchmark 组成评估框架

本文档不是重新发明一个与论文 benchmark 平行的数据集，而是从 Hu et al., *Memory in the Age of
AI Agents* 的 Table 8 中选出四个 benchmark，给它们实现统一的 pi-memo adapter：

| 层 | 选用 benchmark | 在框架中的职责 | pi-memo 主要对象 |
|---|---|---|---|
| B1 | [MemoryAgentBench](https://github.com/HUST-AI-HYZ/MemoryAgentBench) | 主干：增量输入下的检索、学习、整体理解、选择性遗忘 | `memory_recall`、`memory_write`、`memory_revise`、`memory_forget` |
| B2 | [HaluMem](https://github.com/MemTensor/HaluMem) | 可靠性：定位 extraction、update、QA 三阶段的幻觉和遗漏 | 写入内容、更新后的 store、最终回答 |
| B3 | [Evo-Memory](https://arxiv.org/abs/2511.20857) | 经验记忆：连续任务中能否积累、筛选和复用策略 | `exp` memory 与 hit/recency ranking |
| B4 | [SWE-bench Verified](https://www.swebench.com/SWE-bench/) | 外部效度：记忆是否真正提高后续 coding task 成功率 | 完整 pi agent + pi-memo |

其中 LongMemEval 不另立一层，而是使用 MemoryAgentBench 已重构的 LongMemEval-S 子集。这样既保留
LongMemEval 的五种能力标签和官方 QA grader，又遵循 MemoryAgentBench 的增量多轮协议。

四层各回答一个不可互相替代的问题：

1. B1：能不能记、找、改、忘？
2. B2：记忆内容是否忠实，错误在哪个操作阶段产生？
3. B3：过去的成功或失败经验是否让后续任务越来越好？
4. B4：这些能力在真实代码任务上是否有净收益？

现有 Vitest 继续作为实现正确性的 preflight，但不计入 benchmark 总分。

## 2. 为什么选择这些 benchmark

### 2.1 MemoryAgentBench 作为主干

它的输入是按时间顺序逐块交给 agent 的，而不是一次塞入完整长上下文，最接近 pi-memo 跨 session
积累记忆的工作方式。它定义四项能力：Accurate Retrieval (AR)、Test-Time Learning (TTL)、
Long-Range Understanding (LRU) 和 Selective Forgetting (SF)。这四项正好覆盖当前四个工具的主要行为。

核心套件只跑下列子集：

| 能力 | 数据集 | 采用原因 | 官方输出指标 |
|---|---|---|---|
| AR | EventQA | 单跳和多跳事实分散在事件流中；适合测 BM25 和显式 recall | 官方 QA 指标 |
| AR | LongMemEval-S（MAB 版本） | 包含单 session、多 session、时间、更新和拒答问题 | 官方 LLM judge/accuracy，并另算 evidence recall |
| TTL | BANKING77、CLINC150 | 从前序样例中获得新的分类规则，能测试 `exp` 是否可复用 | accuracy |
| LRU | DetectiveQA | 需要跨长序列整合信息，不只是找到一个 needle | accuracy |
| SF | FactConsolidation-SH/MH | 新事实覆盖或合并旧事实，直接对应 revise/forget | 官方 QA 指标 |

SH/MH Document QA、Movie Recommendation 和 InfiniteBench-Sum 放入 extended profile，不进入日常回归：
它们分别与 EventQA、TTL、DetectiveQA 重叠，且运行成本更高。

### 2.2 HaluMem 作为操作级可靠性层

MemoryAgentBench 的最终 QA 错误无法说明问题发生在写入、更新、检索还是回答阶段。HaluMem 原生将
流程拆成 Memory Extraction、Memory Update 和 Memory Question Answering，并分别报告完整性、准确性、
幻觉和遗漏。pi-memo 的记忆是可读 Markdown，特别适合直接对 store 做 operation-level grading。

核心套件使用 HaluMem-Medium；HaluMem-Long（每个用户上千轮、总体上下文超过百万 token）只在发布前
或检索结构变更时运行。

### 2.3 Evo-Memory 作为经验复用层

MemoryAgentBench 的 TTL 主要看“从示例学会一个当前任务”，而 pi-memo 的 `exp` 设计目标是“下次遇到
类似问题怎么办”。Evo-Memory 把任务排列成 stream，并允许每次交互后继续检索、整合和修改经验，
因此用它检查：

- 成功经验是否带来 forward transfer；
- 失败经验是否被错误固化并造成 negative transfer；
- 相似任务增加时，累计表现是否改善；
- memory 数量增长后，步数、token 和检索噪声是否失控。

第一阶段选取一个可确定判分的 single-turn reasoning stream 和一个交互式 stream。具体数据集名称由
adapter config 固定，不能在看到结果后选择。完整 10-task suite 放入 extended profile。

### 2.4 SWE-bench Verified 作为 coding 外部效度层

前三层主要是语言、分类或交互任务。即使得分高，也不等于能帮助 coding agent。SWE-bench Verified
提供真实 GitHub issue、仓库和容器化测试判分，但单个 issue 本身通常不需要跨 session 记忆。因此本
框架不是直接跑 500 个独立 issue，而是按 repository 组织成 task stream：同一 repo 的前序实例允许形成
`env`/`exp`，后序实例可以复用；每个 instance 仍使用官方容器和 pass/fail grader。

该结果应标注为 `SWE-bench Verified / longitudinal`，不能当作官方 leaderboard 的标准独立实例分数。

## 3. 统一执行模型

```text
official dataset
      │
      ▼
BenchmarkAdapter ──► ordered chunks / queries / feedback
      │
      ▼
EpisodeRunner ─────► fresh pi sessions + isolated memory stores
      │
      ▼
PiMemoAdapter ─────► tool trace + memory snapshots + retrieval trace
      │
      ├──► official benchmark grader
      ├──► operation/provenance grader
      └──► cost and state-integrity grader
```

### 3.1 `BenchmarkAdapter`

每个 benchmark adapter 只负责把官方格式转换成同一个 event stream，不改问题、答案或顺序：

```typescript
interface BenchmarkAdapter {
  readonly benchmark: "memory-agent-bench" | "halumem" | "evo-memory" | "swe-bench-verified";
  load(split: string, limit?: number): AsyncIterable<BenchmarkInstance>;
  events(instance: BenchmarkInstance): AsyncIterable<EvalEvent>;
  grade(instance: BenchmarkInstance, trace: RunTrace): Promise<OfficialScores>;
}

type EvalEvent =
  | { type: "observe"; sourceId: string; timestamp?: string; content: string }
  | { type: "query"; queryId: string; content: string }
  | { type: "feedback"; content: string }
  | { type: "reset-session" }
  | { type: "reset-store" };
```

`sourceId` 只保存在 evaluation trace 中，不写入正式 memory schema。runner 记录每次 write/revise 前最近
处理的 source ids，由此建立 `memory id -> source ids` provenance，才能在不修改 pi-memo 产品格式的情况
下计算 evidence recall 和错误传播。

### 3.2 `PiMemoAdapter`

adapter 必须通过真实扩展入口驱动工具，不直接调用内部 `Memo.search` 作为主结果：

```typescript
interface MemorySystemAdapter {
  resetStores(): Promise<void>;
  startSession(): Promise<void>;
  observe(event: EvalEvent): Promise<AgentTurn>;
  query(event: EvalEvent): Promise<AgentTurn>;
  snapshot(): Promise<MemorySnapshot>;
}
```

可以另跑 `Memo.search` 的 oracle-seeded component track，用来定位 BM25 问题，但 component track 不可
替代 end-to-end benchmark 分数。

### 3.3 session 语义

- `observe` 块按 benchmark 原顺序输入。
- 每个官方 chunk 后执行 `agent_settled`，确保 usage 被 flush。
- MemoryAgentBench、HaluMem 和 Evo-Memory 的每个任务/episode 后启动新 pi session，使 session index 按
  产品语义刷新。
- 同一 benchmark instance 共用 store；不同 instance 必须使用全新的 global/project store。
- query session 看不到原始历史，只能看到固定 index 和主动 recall 的结果。
- 为保证可比性，另设 `official-continuous` profile，不在 chunk 间强制新 session；两种 profile 不混报。

## 4. 三种评估轨道

每个 B1-B3 benchmark 尽量运行以下三条轨道。它们用同一数据和官方 grader，但定位不同能力。

| 轨道 | Formation | Retrieval | Reader | 说明 |
|---|---|---|---|---|
| `oracle-memory` | gold evidence 转成规范 memory | gold memory 直接注入 | 固定模型 | reader 上限 |
| `oracle-write` | gold evidence 转成规范 memory | pi-memo BM25 + agent recall | 同一固定模型 | 隔离检索质量 |
| `agentic` | agent 自主 write/revise/forget | agent 自主决定是否 recall | 同一固定模型 | 产品主结果 |

此外保留两个 baseline：

- `no-memory`：每个 query 只有当前问题；
- `full-history`：按官方协议把历史全部放入上下文。

对 Evo-Memory 再加入其 ExpRAG baseline；对 SWE-bench longitudinal 加入 `fresh-store-per-instance`，以隔离
“同一模型与 scaffold”下 memory 的净作用。

## 5. 各 benchmark 的具体运行协议

### B1. MemoryAgentBench

1. 使用官方 processed split 和 chunk 顺序。
2. 每个 chunk 作为一次 `observe`；agent 可以选择不写，也可以写多条 atomic memory。
3. 到官方 query 位置才提问，禁止提前暴露问题。
4. 输出交给每个子数据集的官方 grader；不把不同 task 的原始指标强行平均。
5. 另外记录：
   - gold evidence 所在 source 是否被写入任何 memory：`formation_recall`；
   - recall 返回的 memory 是否覆盖 gold source：`evidence_recall@k`；
   - 相关 memory 已存在时是否调用 recall：`recall_policy_recall`；
   - FactConsolidation 后旧事实是否仍在可召回 store：`stale_retention_rate`。

主报告按 AR/TTL/LRU/SF 四列展示；只有在需要单一回归信号时才计算四项 macro average。

### B2. HaluMem

1. Extraction：逐段输入对话，比较最终 Markdown entries 与 reference memory points。
2. Update：先载入旧 memory，再输入官方更新/冲突对话；比较 revise 后的 store。
3. QA：从 agentic store 回答官方问题。
4. 保留官方 memory integrity/accuracy、update hallucination/omission、QA hallucination/omission 指标。
5. 为 pi-memo 补充确定性检查：
   - immutable 字段（id、scope、kind、created）没有被改变；
   - 被忘记 id 已从文件、`MEMORY.md`、cache、usage 全部消失；
   - duplicate/conflict id 没有被工具读取；
   - `env.verify` 失败的记忆没有被当作可靠事实使用。

HaluMem 是 safety gate：不能用其他 benchmark 的高准确率抵消它的幻觉或删除失败。

### B3. Evo-Memory

1. 采用官方 task stream 顺序，不按难度或相似度重排。
2. task 完成后向 agent 提供官方环境结果/正确性反馈，再允许写或 revise `exp`。
3. 失败轨迹与成功轨迹都可见，不能预先过滤失败，以测错误经验污染。
4. 记录每个位置的官方 task score，画 cumulative score curve。
5. 与 `no-memory`、History、ExpRAG 比较：
   - `online_gain_t = score(pi-memo, t) - score(no-memory, t)`；
   - `forward_transfer`：后半段平均 online gain；
   - `negative_transfer`：no-memory 成功但 pi-memo 因引用错误经验失败的比例；
   - 平均步骤数、memory 数量、recall 数量和 token/cost。
6. 将 `hitBoost`、`recencyBoost`、`scopeBoost` 分别关闭做 ranking ablation。

Evo-Memory 的主结论来自整条 stream，不把每个任务当作独立 IID 样本。

### B4. SWE-bench Verified / longitudinal

1. 先选 4-6 个实例较多、环境稳定的 repository；在每个 repo 内固定 5-10 个实例的顺序。
2. 实例仍在官方 Docker 环境独立执行，使用官方 `resolved` 判分。
3. 只让 memory store 跨实例保留；代码工作树、对话 history 和容器均重置。
4. 对比同一模型、prompt、工具预算下：
   - `fresh-store-per-instance`；
   - `persistent-pi-memo`；
   - `persistent-pi-memo-no-exp`，用于区分 repo facts 和经验策略的贡献。
5. 主指标为 paired resolve-rate delta；次指标为步骤、token、成本和 wall time。
6. 每个改变 pass/fail 的实例都做 counterfactual replay：移除本次实际召回的 memories 后重跑，确认改变
   确由 memory 导致。

SWE-bench 可能存在模型预训练污染，而且这种 longitudinal 重排不是官方协议，因此只用于项目内部的
外部效度，不对外宣称 leaderboard 可比性。

## 6. 统一指标与诊断

### 6.1 主指标

| 维度 | 主指标 | 来源 |
|---|---|---|
| Retrieval | AR 官方分数、evidence recall@5 | MemoryAgentBench |
| Formation | memory integrity / accuracy | HaluMem Extraction |
| Evolution | SF 官方分数、update hallucination/omission | MemoryAgentBench + HaluMem Update |
| Experience | cumulative score、forward/negative transfer | Evo-Memory |
| Downstream | paired resolve-rate delta | SWE-bench Verified |

### 6.2 成本与系统指标

所有 benchmark 统一记录：input/output token、模型调用数、四类 memory tool 调用数、写入条目数、store
字节数、注入 index token、recall p50/p95 latency、总 wall time 和估算成本。

### 6.3 不做一个总分

保留五个主维度的 scorecard，不做加权总分。原因是 deletion failure、memory hallucination 这类可靠性
问题不能被 SWE-bench 的少量收益抵消。CI 可以为每个维度单独设 gate。

## 7. 结果文件与可复现性

```text
eval/
  adapters/
    memory-agent-bench.ts
    halumem.ts
    evo-memory.ts
    swe-bench.ts
  runners/
    episode.ts
    pi-memo.ts
  graders/
    provenance.ts
    state-integrity.ts
  configs/
    smoke.yaml
    core.yaml
    extended.yaml
  results/<run-id>/
    manifest.json
    events.jsonl
    memories/
    official-scores.json
    diagnostics.json
    report.md
```

`manifest.json` 至少固定：benchmark 名称与 commit/data revision、split、实例 ids、顺序、pi-memo commit、
model、prompt hash、temperature、seed、tokenizer、`nodejieba` 是否启用、依赖 lock hash 和运行平台。

`events.jsonl` 为 append-only，逐事件记录：输入 source/query id、session id、tool call、tool result、retrieved
ids/scores、memory diff、最终回答、官方判分和成本。不得保存 API key 或真实用户 memory。

## 8. 运行 profile

| Profile | 内容 | 触发时机 |
|---|---|---|
| `smoke` | 每个 benchmark 5-10 个固定实例，单 seed | PR |
| `core` | B1 核心子集 + HaluMem-Medium + 两条 Evo streams + SWE longitudinal 20-30 instances | 主分支定期运行 |
| `extended` | MAB 全子集、HaluMem-Long、Evo 10-task suite、更多 SWE repos | release/研究报告 |

PR 的 smoke profile 只检查 runner 与 adapter 没坏，不能用于性能结论。涉及检索、prompt 或工具说明的
改动必须跑 core。

## 9. 实验纪律与 release gates

- 统一模型、system prompt、工具预算和 temperature；比较条件只改变 memory。
- agentic 结果至少 5 seeds，报告 paired bootstrap 95% CI；确定性官方 grader 与 LLM judge 分开报告。
- 开发集可用于调 BM25 权重或 prompt；core test 实例不得按错误案例反复调参。
- benchmark 数据不得写入项目的真实 global memory；每个 instance 使用隔离临时目录。
- 同时报告 overall 和 task/category slice，避免平均数掩盖 SF 或 update 退化。
- 保存失败案例的完整 provenance：source -> written memory -> recalled memory -> answer/action。

第一轮完整运行后再根据 baseline 校准数值 gate。在此之前只设三条硬 gate：

1. HaluMem + state-integrity grader 中的显式删除完整率必须为 100%；
2. 所有 benchmark 之间不得发生 store 污染；
3. `persistent-pi-memo` 在 SWE longitudinal 上不得出现统计显著的负收益。

## 10. 实施顺序

1. 先实现通用 event schema、`PiMemoAdapter`、trace 和两种 baseline。
2. 接 MemoryAgentBench 的 EventQA、LongMemEval-S 和 FactConsolidation，打通 B1 主闭环。
3. 接 HaluMem-Medium；这一步会验证 provenance 与 store snapshot 是否足以定位错误。
4. 接 Evo-Memory 两条 stream，并实现 boosts ablation。
5. 最后接 SWE-bench Docker harness；先跑单 repo 小流，再扩到 core profile。

最小可用版本不是自建 80-120 条检索题，而是：同一 runner 下能够完整跑通 MemoryAgentBench 的三个
关键子集，并同时产出官方分数、formation/evidence provenance 和 pi-memo state-integrity 诊断。
