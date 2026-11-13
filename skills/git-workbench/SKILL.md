---
name: git-workbench
description: Read-only Git inspection for the current workspace. Use when the user asks what changed, wants a diff explained, asks about branches, or wants to browse commit history and commit contents. Also opens the Git Workbench side panel.
---

# Git Workbench (read-only)

The `git` MCP server exposes read-only inspection tools for the current workspace. Nothing here stages, reverts, commits or pushes; write operations are intentionally unavailable in this version.

## Tools

- `git_status` — repository state, current branch, ahead/behind, staged/unstaged/untracked/conflicted files.
- `git_diff` — unified diff for worktree, staged or a single untracked file. Input: `{ scope: "worktree"|"staged"|"untracked", path?, cursor?, context? }`. Untracked diffs require `path`.
- `git_log` — commits in topological order with parents and refs. Input: `{ limit?, cursor?, branch?, path? }`. Page with `cursor`; `branch` defaults to all branches.
- `git_branches` — local/remote branches and tags with ahead/behind counts.
- `git_commit_detail` — full message plus per-file add/delete stats. Input: `{ hash }`. Merge commits compare against the first parent.
- `git_commit_diff` — one file's diff inside a commit. Input: `{ hash, path, cursor?, context? }`.
- `open_git_panel` — open the Git Workbench side panel for the user.

## Working rules

- Paths are relative to the repository root, not the workspace directory. Use the paths returned by `git_status` / `git_commit_detail`.
- Diffs are paginated: when the result has `next` set, call again with `cursor` instead of assuming the diff ended.
- `git_status` returns `isRepo: false` instead of failing when the workspace is not a Git repository; explain that to the user rather than retrying.
- Prefer `git_status` before answering "what changed"; prefer `git_log` + `git_commit_detail` for history questions.
- When the user wants to inspect changes visually, call `open_git_panel` and mention the panel title ("Git 工作台").
