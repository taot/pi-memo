## 问题 1

不过查下来，Relationship 这张表的 oracle 质量有个不小的问题：

376 行里有 119 行，related 任务和它的「历史经验」指向的是同一个 PR。

比如 astropy__astropy-4973 配 astropy__astropy-7746，两边的 pr_url 都是 astropy/astropy/pull/7746——一个 PR 同时关掉了 issue 
#4973
 和 #7389，benchmark 把这两个 issue 拆成了「新题」和「旧经验」。

这本身算真实的依赖关系，但落到评测上：这 119 对里有 36 对，两边存的 gold patch 逐字节完全相同。也就是说，把「历史经验」喂给 agent，等于直接把这道题的标准答案递过去了。36/376 ≈ 10% 的待测任务存在这种答案泄漏。

这和之前发现的时序问题是同一个根源——Relationship 建立在 issue/PR 的引用关系上，而不是时间先后（只有 31% 的配对经验确实更早）。用它做「上下文复用有收益」的论证时，这 10% 会系统性地把 oracle 那一组的成绩抬高。

想要干净的子集，可以这样筛：

clean = relationship[
    (relationship["related_pr_url"] != relationship["experience_pr_url"])
]

再叠加之前那个 gap_days > 0 的时序条件。

## 问题 2

另外 Lite 那对不是自足的——related_lite 需要的经验里有 1 条只存在于完整经验池，不在 experience_lite 里。只跑 lite 的话那题的 oracle 是缺的。
