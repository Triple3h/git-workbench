import { paginate, looksBinary } from "./diff.mjs";
import {
  GitError,
  NOT_A_REPO_HINT,
  findRepo,
  readBranches,
  readCommitDetail,
  readCommitDiff,
  readLog,
  readStatus,
  readWorkingDiff,
  requireRepo,
  workspaceRoot,
} from "./git.mjs";

export const SURFACE_ID = "git";
export const PANEL_URI = "ui://git-workbench/panel.html";

const MODEL_AND_APP = { ui: { visibility: ["model", "app"] } };

function ok(text, structured) {
  return {
    content: [{ type: "text", text }],
    ...(structured === undefined ? {} : { structuredContent: structured }),
  };
}

function objectSchema(properties = {}, required = []) {
  return {
    type: "object",
    properties,
    additionalProperties: false,
    ...(required.length > 0 ? { required } : {}),
  };
}

function statusSummary(status) {
  if (!status.isRepo) {
    return `当前工作区不是 Git 仓库：${status.workspace}`;
  }
  const lines = [];
  const branchLabel = status.unborn
    ? "尚无提交"
    : status.detached
      ? "HEAD（游离）"
      : status.branch ?? "未知分支";
  const tracking = [];
  if (status.ahead) tracking.push(`领先 ${status.ahead}`);
  if (status.behind) tracking.push(`落后 ${status.behind}`);
  lines.push(`分支 ${branchLabel}${tracking.length ? `（${tracking.join("，")}）` : ""}`);
  lines.push(
    `${status.counts.staged} 个已暂存 · ${status.counts.unstaged} 个未暂存 · ${status.counts.untracked} 个未跟踪${
      status.counts.conflicted ? ` · ${status.counts.conflicted} 个冲突` : ""
    }`
  );
  if (status.head) lines.push(`最新提交：${status.head.hash.slice(0, 7)} ${status.head.subject}`);
  lines.push(`仓库：${status.root}`);
  for (const [label, list] of [
    ["已暂存", status.groups.staged],
    ["未暂存", status.groups.unstaged],
    ["未跟踪", status.groups.untracked],
    ["冲突", status.groups.conflicted],
  ]) {
    if (!list.length) continue;
    lines.push("", `${label}：`);
    for (const file of list.slice(0, 30)) {
      const rename = file.origPath ? ` ← ${file.origPath}` : "";
      lines.push(`  ${file.status} ${file.path}${rename}`);
    }
    if (list.length > 30) lines.push(`  … 其余 ${list.length - 30} 个`);
  }
  return lines.join("\n");
}

async function statusTool() {
  const repo = await findRepo(workspaceRoot());
  if (!repo.isRepo) {
    return ok(statusSummary({ isRepo: false, workspace: repo.workspace }), {
      isRepo: false,
      workspace: repo.workspace,
      root: null,
    });
  }
  const status = await readStatus(repo);
  return ok(statusSummary(status), status);
}

async function diffTool({ scope, path: filePath, oldPath, cursor, context }) {
  const repo = await requireRepo(workspaceRoot());
  const diff = await readWorkingDiff(repo, {
    scope,
    filePath,
    oldPath,
    context,
  });
  const page = paginate(diff.text, cursor ?? 0);
  const empty = diff.text.trim() === "";
  return {
    content: [{ type: "text", text: empty ? "" : page.text }],
    structuredContent: {
      scope: diff.scope,
      path: diff.path,
      empty,
      binary: looksBinary(diff.text),
      next: page.next,
      totalLines: page.totalLines,
    },
  };
}

async function logTool({ limit, cursor, branch, path: filePath }) {
  const repo = await requireRepo(workspaceRoot());
  const result = await readLog(repo, {
    limit: limit ?? 120,
    cursor: cursor ?? 0,
    branch: branch ?? "all",
    filePath: filePath ?? null,
  });
  const lines = result.unborn
    ? ["仓库尚无提交"]
    : result.commits.map((commit) => {
        const refs = commit.refs.map((ref) => ref.name).join(", ");
        return `${commit.short} ${commit.subject}${refs ? `  [${refs}]` : ""} — ${commit.author}, ${commit.date}`;
      });
  if (result.nextCursor !== null) lines.push(`… 下一页 cursor=${result.nextCursor}`);
  return ok(lines.join("\n"), result);
}

async function branchesTool() {
  const repo = await requireRepo(workspaceRoot());
  const status = await readStatus(repo);
  const branches = await readBranches(repo);
  const lines = [`当前分支：${branches.current ?? (status.detached ? "HEAD（游离）" : "无")}`];
  lines.push(`本地 ${branches.local.length} · 远程 ${branches.remote.length} · 标签 ${branches.tags.length}`);
  for (const item of branches.local.slice(0, 40)) {
    const tracking = [item.ahead ? `↑${item.ahead}` : "", item.behind ? `↓${item.behind}` : ""]
      .filter(Boolean)
      .join(" ");
    lines.push(`  ${item.current ? "*" : " "} ${item.name}${tracking ? ` ${tracking}` : ""}`);
  }
  return ok(lines.join("\n"), {
    current: branches.current,
    detached: status.detached,
    unborn: status.unborn,
    head: status.head,
    ...branches,
  });
}

async function commitDetailTool({ hash }) {
  const repo = await requireRepo(workspaceRoot());
  const detail = await readCommitDetail(repo, hash);
  const lines = [
    `${detail.short} ${detail.subject}`,
    `${detail.author} <${detail.email}> · ${detail.authoredAt}`,
    detail.merge ? `合并提交（diff 相对第一父提交 ${detail.parents[0]?.slice(0, 7) ?? ""}）` : "",
    `文件 ${detail.stats.files} · +${detail.stats.additions} −${detail.stats.deletions}`,
    "",
  ].filter(Boolean);
  for (const file of detail.files.slice(0, 60)) {
    const counts = file.binary
      ? "binary"
      : `${file.additions === null ? "?" : file.additions} + / ${file.deletions === null ? "?" : file.deletions} -`;
    const rename = file.origPath ? ` ← ${file.origPath}` : "";
    lines.push(`${file.status} ${file.path}${rename}  (${counts})`);
  }
  if (detail.files.length > 60) lines.push(`… 其余 ${detail.files.length - 60} 个文件`);
  if (detail.body) lines.push("", detail.body);
  return ok(lines.join("\n"), detail);
}

async function commitDiffTool({ hash, path: filePath, oldPath, cursor, context }) {
  const repo = await requireRepo(workspaceRoot());
  const diff = await readCommitDiff(repo, { hash, filePath, oldPath, context });
  const page = paginate(diff.text, cursor ?? 0);
  const empty = diff.text.trim() === "";
  return {
    content: [{ type: "text", text: empty ? "" : page.text }],
    structuredContent: {
      hash: diff.hash,
      path: diff.path,
      empty,
      binary: looksBinary(diff.text),
      next: page.next,
      totalLines: page.totalLines,
    },
  };
}

async function openPanelTool() {
  const repo = await findRepo(workspaceRoot());
  if (!repo.isRepo) {
    return ok(
      `Git 工作台面板已请求打开。当前工作区不是 Git 仓库：${repo.workspace}`,
      { isRepo: false, workspace: repo.workspace, root: null }
    );
  }
  const status = await readStatus(repo);
  return ok(`Git 工作台面板已请求打开。\n\n${statusSummary(status)}`, status);
}

export function createTools() {
  return [
    {
      name: "git_status",
      description:
        "Read the current Git repository state: branch, ahead/behind, staged, unstaged, untracked and conflicted files. Returns isRepo:false when the workspace is not a Git repository.",
      inputSchema: objectSchema(),
      annotations: { readOnlyHint: true },
      _meta: MODEL_AND_APP,
      handler: statusTool,
    },
    {
      name: "git_diff",
      description:
        "Read a unified diff from the working tree or the index. Use scope=untracked with a path to diff a single untracked file. Diffs are paginated: pass cursor from a previous result when next is set.",
      inputSchema: objectSchema(
        {
          scope: {
            type: "string",
            enum: ["worktree", "staged", "untracked"],
            description: "Which diff to read.",
          },
          path: {
            type: "string",
            description: "Repository-relative path. Optional for worktree/staged, required for untracked.",
          },
          oldPath: {
            type: "string",
            description: "Original path for a rename, from git_status. Required for rename detection.",
          },
          cursor: { type: "integer", minimum: 0, description: "Line cursor from a previous page." },
          context: { type: "integer", minimum: 0, maximum: 20, description: "Context lines, default 3." },
        },
        ["scope"]
      ),
      annotations: { readOnlyHint: true },
      _meta: MODEL_AND_APP,
      handler: diffTool,
    },
    {
      name: "git_log",
      description:
        "Read commits in topological order with parents and refs, across all branches by default. Page with cursor; optionally filter by branch or path.",
      inputSchema: objectSchema({
        limit: { type: "integer", minimum: 1, maximum: 300, description: "Commits per page, default 120." },
        cursor: { type: "integer", minimum: 0, description: "Offset from a previous nextCursor." },
        branch: { type: "string", description: "Branch or ref name; omit or use 'all' for every branch." },
        path: { type: "string", description: "Only commits touching this repository-relative path." },
      }),
      annotations: { readOnlyHint: true },
      _meta: MODEL_AND_APP,
      handler: logTool,
    },
    {
      name: "git_branches",
      description:
        "List local and remote branches and tags with the current branch and ahead/behind counts.",
      inputSchema: objectSchema(),
      annotations: { readOnlyHint: true },
      _meta: MODEL_AND_APP,
      handler: branchesTool,
    },
    {
      name: "git_commit_detail",
      description:
        "Read one commit: full message, parents and per-file additions/deletions. Merge commits are compared against their first parent.",
      inputSchema: objectSchema({ hash: { type: "string", description: "Commit hash (full or abbreviated)." } }, [
        "hash",
      ]),
      annotations: { readOnlyHint: true },
      _meta: MODEL_AND_APP,
      handler: commitDetailTool,
    },
    {
      name: "git_commit_diff",
      description:
        "Read one file's unified diff inside a commit. Paginated like git_diff; merge commits compare against the first parent.",
      inputSchema: objectSchema(
        {
          hash: { type: "string", description: "Commit hash." },
          path: { type: "string", description: "Repository-relative path inside the commit." },
          oldPath: {
            type: "string",
            description: "Original path for a rename, from git_commit_detail.",
          },
          cursor: { type: "integer", minimum: 0 },
          context: { type: "integer", minimum: 0, maximum: 20 },
        },
        ["hash", "path"]
      ),
      annotations: { readOnlyHint: true },
      _meta: MODEL_AND_APP,
      handler: commitDiffTool,
    },
    {
      name: "open_git_panel",
      description:
        "Open the Git Workbench side panel for the user. Returns the current repository state; works for non-repositories too.",
      inputSchema: objectSchema(),
      annotations: { readOnlyHint: true },
      _meta: {
        ui: {
          resourceUri: PANEL_URI,
          surface: SURFACE_ID,
          visibility: ["model", "app"],
          preferredDisplayMode: "fullscreen",
        },
        "openai/ui": { preferredModelDisplayMode: "fullscreen" },
      },
      handler: openPanelTool,
    },
  ];
}

export { GitError, NOT_A_REPO_HINT };
