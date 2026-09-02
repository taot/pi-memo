# pi-memo

Long-term memory for [pi](https://pi.dev). Memories are plain Markdown files you can read,
edit by hand, diff and commit. The model stores and retrieves them through explicit tools;
every session starts with a small index of what is remembered.

See [docs/DESIGN.md](docs/DESIGN.md) for the design and its mapping to the memory survey it follows.
The proposed evaluation protocol is in [docs/EVALUATION.md](docs/EVALUATION.md).

## Install

```bash
pi install /path/to/pi-memo
```

Or try it for one run:

```bash
pi -e /path/to/pi-memo/index.ts
```

## Layout

```text
~/.pi/memo/          user/ env/ exp/ + MEMORY.md   # global memory
<repo>/.pi/memo/     env/ exp/ + MEMORY.md         # project memory, committed with the repo
```

`.cache/` (retrieval index) and `.local/` (usage stats) are rebuildable; keep them out of git:

```gitignore
.pi/memo/.cache/
.pi/memo/.local/
```

Each memory is one file holding one conclusion:

```markdown
---
id: wayland-no-window-positioning
kind: env
title: Wayland 不暴露窗口坐标设定，KDE 下 set_outer_position 不生效
created: 2026-08-31T14:22:07-04:00
updated: 2026-08-31T14:22:07-04:00
verify:
  kind: url
  ref: https://wayland.freedesktop.org/docs/html/
  expect: xdg-shell has no window positioning request
tags: [kde, wayland, winit]
---

Wayland 协议没有“把窗口放到 (x, y)”的请求。winit 的
`set_outer_position` 在 KDE 下不报错，也不生效。
```

`kind` is `user` (preferences and standing commitments), `env` (facts you can verify) or
`exp` (what to do next time). `user` memories are global only.

## Tools

| Tool | Purpose |
|---|---|
| `memory_recall` | Read entries by `ids`, or search everything by `query` (BM25, kind/scope/recency/hit boosts) |
| `memory_write` | Store one new memory; rejects duplicate ids and flags near-duplicate titles |
| `memory_revise` | Update in place, keeping `id`, `scope`, `kind` and `created` |
| `memory_forget` | Delete the file, the index line, the cache entry and the usage record |

Writes, revisions and deletions land on disk immediately and refresh `MEMORY.md` and the
retrieval cache, so later recalls in the same session see them. The index snapshot injected
into context stays fixed until the next session.

## Commands

- `/memo-gc` — check formats and id conflicts, run `env.verify` checks, list possible
  duplicates and entries not hit in 90 days, rebuild `MEMORY.md` and `.cache/`, and write
  `GC-REPORT.md` per store. It reports; it never edits. URLs are checked for HTTP status only
  unless you pass `--check-urls=true`.
- `/memo-stats` — entry counts by scope and kind, never-recalled ratio, and the size of the
  injected index against its limits.

An id that resolves to more than one memory file is excluded from the index and from every
tool until you resolve it by hand.

## Development

```bash
npm install
npm run check
npm test
```

Chinese segmentation uses `nodejieba` when it is installed (an optional dependency). Without
it the tokenizer falls back to unigrams plus bigrams, which keeps recall working.
