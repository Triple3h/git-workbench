import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { normalizeDiff } from "./diff.mjs";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 32 * 1024 * 1024;
const DEFAULT_TIMEOUT = 15_000;
const MAX_STATUS_ENTRIES = 2_000;
const MAX_COMMIT_FILES = 800;
const LOG_JSON_BUDGET = 48 * 1024;
const MAX_REFS = 500;

const GIT_ENV = {
  LC_ALL: "C",
  LANG: "C",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_PAGER: "cat",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_LITERAL_PATHSPECS: "1",
};

export class GitError extends Error {
  constructor(code, message, detail) {
    super(message);
    this.name = "GitError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }
}

export const NOT_A_REPO_HINT =
  "Git 工作台只能查看 Git 仓库。请在包含 .git 的工作区中打开，或先用 git init 初始化。";

function gitFailure(stderr, exitCode) {
  const text = String(stderr ?? "").trim();
  const first = text.split("\n").filter(Boolean).slice(0, 4).join("\n");
  if (/not a git repository/i.test(text)) {
    return new GitError("not_a_repo", "当前工作区不是 Git 仓库", NOT_A_REPO_HINT);
  }
  if (/unknown revision|bad object|ambiguous argument|not a valid object name/i.test(text)) {
    return new GitError("invalid_ref", "未知的提交或引用");
  }
  if (/does not have any commits yet|your current branch .* does not have any commits/i.test(text)) {
    return new GitError("unborn", "仓库还没有任何提交");
  }
  if (/no such file|does not exist|could not access/i.test(text)) {
    return new GitError("not_found", first || "文件不存在");
  }
  return new GitError("git_failed", first || `git 退出码 ${exitCode}`);
}

export async function runGit(args, options = {}) {
  const {
    cwd,
    timeout = DEFAULT_TIMEOUT,
    maxBuffer = MAX_BUFFER,
    allowExit = [0],
  } = options;
  try {
    const { stdout, stderr } = await execFileAsync("git", args, {
      cwd,
      timeout,
      maxBuffer,
      encoding: "utf8",
      env: { ...process.env, ...GIT_ENV },
      windowsHide: true,
    });
    return { stdout, stderr, code: 0 };
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new GitError("git_missing", "找不到 git 命令", "请确认已安装 Git，并且它位于本次会话的 PATH 中。");
    }
    if (error?.killed) {
      throw new GitError("git_timeout", `git 命令执行超时（${timeout}ms）`);
    }
    const exitCode = typeof error?.code === "number" ? error.code : 1;
    if (allowExit.includes(exitCode)) {
      return { stdout: error.stdout ?? "", stderr: error.stderr ?? "", code: exitCode };
    }
    throw gitFailure(error?.stderr ?? error?.message, exitCode);
  }
}

async function safeRealpath(target) {
  try {
    return await realpath(target);
  } catch {
    return path.resolve(target);
  }
}

export async function findRepo(workspace) {
  const ws = await safeRealpath(workspace);
  try {
    const result = await runGit(["rev-parse", "--show-toplevel"], {
      cwd: ws,
      allowExit: [0, 128],
    });
    if (result.code !== 0 || !result.stdout.trim()) {
      return { isRepo: false, workspace: ws, root: null };
    }
    const root = await safeRealpath(result.stdout.trim());
    return { isRepo: true, workspace: ws, root };
  } catch (error) {
    if (error?.code === "git_missing") throw error;
    return { isRepo: false, workspace: ws, root: null };
  }
}

export async function requireRepo(workspace) {
  const repo = await findRepo(workspace);
  if (!repo.isRepo) {
    throw new GitError("not_a_repo", "当前工作区不是 Git 仓库", NOT_A_REPO_HINT);
  }
  return repo;
}

export function safeRel(repo, value, { allowEmpty = false } = {}) {
  if (value === undefined || value === null || value === "") {
    if (allowEmpty) return null;
    throw new GitError("invalid_path", "缺少文件路径");
  }
  if (typeof value !== "string" || value.includes("\0")) {
    throw new GitError("invalid_path", "文件路径不合法");
  }
  if (path.isAbsolute(value)) {
    throw new GitError("invalid_path", "路径必须是相对仓库根的路径");
  }
  const resolved = path.resolve(repo.root, value);
  const relative = path.relative(repo.root, resolved);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new GitError("path_outside_repo", `路径不在仓库内：${value}`);
  }
  return relative.split(path.sep).join("/");
}

function entry(status, filePath, origPath, submodule = false) {
  return {
    path: filePath,
    status,
    ...(origPath ? { origPath } : {}),
    ...(submodule ? { submodule: true } : {}),
  };
}

function parseBranchHeader(line, meta) {
  const value = line.slice(2);
  const space = value.indexOf(" ");
  if (space === -1) return;
  const key = value.slice(0, space);
  const rest = value.slice(space + 1);
  if (key === "branch.oid") meta.headOid = rest;
  else if (key === "branch.head") meta.headName = rest;
  else if (key === "branch.upstream") meta.upstream = rest;
  else if (key === "branch.ab") {
    const match = /^\+(\d+) -(\d+)$/.exec(rest);
    if (match) {
      meta.ahead = Number(match[1]);
      meta.behind = Number(match[2]);
    }
  }
}

function submoduleFlag(value) {
  return typeof value === "string" && value.startsWith("S");
}

export async function readStatus(repo) {
  const { stdout } = await runGit(
    ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"],
    { cwd: repo.root, maxBuffer: 64 * 1024 * 1024 }
  );

  const tokens = stdout.split("\0");
  const meta = { headOid: null, headName: null, upstream: null, ahead: 0, behind: 0 };
  const staged = [];
  const unstaged = [];
  const untracked = [];
  const conflicted = [];
  let truncated = false;

  const pushLimited = (list, value) => {
    if (list.length >= MAX_STATUS_ENTRIES) {
      truncated = true;
      return;
    }
    list.push(value);
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (!record) continue;
    if (record.startsWith("# ")) {
      parseBranchHeader(record, meta);
      continue;
    }
    const kind = record[0];
    if (kind === "1") {
      const match = /^1 (\S\S) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/s.exec(record);
      if (!match) continue;
      const xy = match[1];
      const sub = match[2];
      const filePath = match[8];
      const submodule = submoduleFlag(sub);
      if (xy[0] !== ".") pushLimited(staged, entry(xy[0], filePath, null, submodule));
      if (xy[1] !== ".") pushLimited(unstaged, entry(xy[1], filePath, null, submodule));
      continue;
    }
    if (kind === "2") {
      const match = /^2 (\S\S) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/s.exec(record);
      if (!match) continue;
      const xy = match[1];
      const sub = match[2];
      const filePath = match[9];
      const origPath = tokens[index + 1] || null;
      index += 1;
      const submodule = submoduleFlag(sub);
      if (xy[0] !== ".") pushLimited(staged, entry(xy[0], filePath, origPath, submodule));
      if (xy[1] !== ".") pushLimited(unstaged, entry(xy[1], filePath, origPath, submodule));
      continue;
    }
    if (kind === "u") {
      const match = /^u (\S\S) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (\S+) (.*)$/s.exec(record);
      if (!match) continue;
      pushLimited(conflicted, entry("U", match[10], null, submoduleFlag(match[2])));
      continue;
    }
    if (kind === "?") {
      pushLimited(untracked, entry("?", record.slice(2)));
      continue;
    }
  }

  const byPath = (a, b) => a.path.localeCompare(b.path, "zh-Hans-CN");
  staged.sort(byPath);
  unstaged.sort(byPath);
  untracked.sort(byPath);
  conflicted.sort(byPath);

  const unborn = !meta.headOid || meta.headOid === "(initial)";
  const detached = !meta.headName || meta.headName === "(detached)";
  const branch = detached ? null : meta.headName;

  let head = null;
  if (!unborn) {
    try {
      const { stdout: headLine } = await runGit(
        ["log", "-1", "--format=%H%x1f%an%x1f%aI%x1f%s"],
        { cwd: repo.root }
      );
      const [hash, author, date, subject] = headLine.replace(/\n$/, "").split("\x1f");
      head = { hash, author, date, subject };
    } catch {
      head = null;
    }
  }

  return {
    isRepo: true,
    root: repo.root,
    workspace: repo.workspace,
    branch,
    detached,
    unborn,
    head,
    upstream: meta.upstream,
    ahead: meta.ahead,
    behind: meta.behind,
    counts: {
      staged: staged.length,
      unstaged: unstaged.length,
      untracked: untracked.length,
      conflicted: conflicted.length,
    },
    groups: { staged, unstaged, untracked, conflicted },
    truncated,
  };
}

function parseTrack(value) {
  const text = String(value ?? "");
  const ahead = /ahead (\d+)/.exec(text);
  const behind = /behind (\d+)/.exec(text);
  return {
    ahead: ahead ? Number(ahead[1]) : 0,
    behind: behind ? Number(behind[1]) : 0,
    gone: /gone/.test(text),
  };
}

export async function readBranches(repo) {
  const format = [
    "%(HEAD)",
    "%(refname)",
    "%(refname:short)",
    "%(objectname:short)",
    "%(upstream:short)",
    "%(upstream:track)",
    "%(creatordate:iso-strict)",
    "%(symref)",
  ].join("\t");

  const { stdout } = await runGit(
    ["for-each-ref", `--format=${format}`, "refs/heads", "refs/remotes", "refs/tags"],
    { cwd: repo.root }
  );

  const local = [];
  const remote = [];
  const tags = [];
  let truncated = false;

  for (const line of stdout.split("\n")) {
    if (!line) continue;
    const parts = line.split("\t");
    if (parts.length < 8) continue;
    const [headMark, refname, shortName, hash, upstream, track, date, symref] = parts;
    if (!refname) continue;
    if (symref) continue;
    if (local.length + remote.length + tags.length >= MAX_REFS) {
      truncated = true;
      break;
    }
    if (refname.startsWith("refs/heads/")) {
      local.push({
        name: shortName,
        hash,
        current: headMark === "*",
        upstream: upstream || null,
        ...parseTrack(track),
        date: date || null,
      });
    } else if (refname.startsWith("refs/remotes/")) {
      remote.push({ name: shortName, hash, date: date || null });
    } else if (refname.startsWith("refs/tags/")) {
      tags.push({ name: shortName, hash, date: date || null });
    }
  }

  const byName = (a, b) => a.name.localeCompare(b.name, "en");
  local.sort(byName);
  remote.sort(byName);
  tags.sort(byName);

  return {
    local,
    remote,
    tags,
    truncated,
    current: local.find((item) => item.current)?.name ?? null,
  };
}

const remoteCache = new Map();

async function remoteNames(repo) {
  const cached = remoteCache.get(repo.root);
  if (cached && Date.now() - cached.at < 30_000) return cached.names;
  try {
    const { stdout } = await runGit(["remote"], { cwd: repo.root });
    const names = stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    remoteCache.set(repo.root, { at: Date.now(), names });
    return names;
  } catch {
    return [];
  }
}

function parseRefs(decoration, remotes) {
  if (!decoration) return [];
  const refs = [];
  const seen = new Set();
  for (const raw of decoration.split(", ")) {
    const value = raw.trim();
    if (!value) continue;
    let ref;
    if (value.startsWith("HEAD -> ")) {
      ref = { name: value.slice(8), type: "head" };
    } else if (value === "HEAD") {
      ref = { name: "HEAD", type: "head" };
    } else if (value.startsWith("tag: ")) {
      ref = { name: value.slice(5), type: "tag" };
    } else if (remotes.some((name) => value === name || value.startsWith(`${name}/`))) {
      ref = { name: value, type: "remote" };
    } else {
      ref = { name: value, type: "branch" };
    }
    const key = `${ref.type}:${ref.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(ref);
  }
  return refs;
}

function splitLogRecords(stdout) {
  return stdout
    .split("\x1e")
    .map((record) => record.replace(/^\n/, ""))
    .filter((record) => record.length > 0);
}

async function validateRef(repo, ref) {
  if (ref === "HEAD") return "HEAD";
  if (typeof ref !== "string" || !ref.trim() || ref.startsWith("-") || ref.includes("\0")) {
    throw new GitError("invalid_ref", "分支名不合法");
  }
  const check = await runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
    cwd: repo.root,
    allowExit: [0, 1, 128],
  });
  if (check.code !== 0 || !check.stdout.trim()) {
    throw new GitError("invalid_ref", `未知分支或引用：${ref}`);
  }
  return ref;
}

export async function readLog(repo, { limit = 120, cursor = 0, branch = "all", filePath = null } = {}) {
  const safeLimit = Math.min(Math.max(Number(limit) || 120, 1), 300);
  const safeCursor = Math.max(Number(cursor) || 0, 0);
  const safePath = safeRel(repo, filePath, { allowEmpty: true });
  const ref = branch && branch !== "all" ? await validateRef(repo, branch) : "--all";

  const args = [
    "log",
    "--topo-order",
    "--date=iso-strict",
    "--pretty=format:%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%D%x1f%s%x1e",
    "-n",
    String(safeLimit),
    "--skip",
    String(safeCursor),
  ];
  args.push(ref);
  if (safePath) args.push("--", safePath);

  const remotes = await remoteNames(repo);
  const result = await runGit(args, { cwd: repo.root, allowExit: [0, 128] });
  if (result.code !== 0) {
    if (/does not have any commits yet/i.test(result.stderr)) {
      return { commits: [], nextCursor: null, unborn: true, branch: ref === "--all" ? "all" : ref };
    }
    throw gitFailure(result.stderr, result.code);
  }

  const records = splitLogRecords(result.stdout);
  const commits = [];
  let bytes = 0;

  for (const record of records) {
    const fields = record.split("\x1f", 7);
    if (fields.length < 7) continue;
    const [hash, parents, author, email, date, decoration, subject] = fields;
    const commit = {
      hash,
      short: hash.slice(0, 7),
      parents: parents ? parents.split(" ").filter(Boolean) : [],
      author,
      email,
      date,
      subject,
      refs: parseRefs(decoration, remotes),
    };
    const size = Buffer.byteLength(JSON.stringify(commit), "utf8") + 1;
    if (commits.length > 0 && bytes + size > LOG_JSON_BUDGET) break;
    commits.push(commit);
    bytes += size;
  }

  const more = commits.length < records.length || records.length >= safeLimit;
  return {
    commits,
    nextCursor: more ? safeCursor + commits.length : null,
    branch: ref === "--all" ? "all" : ref,
    limit: safeLimit,
  };
}

export async function resolveCommit(repo, hash) {
  if (typeof hash !== "string" || !/^[0-9a-fA-F]{4,40}$/.test(hash.trim())) {
    throw new GitError("invalid_hash", "提交哈希不合法");
  }
  const value = hash.trim();
  const check = await runGit(["rev-parse", "--verify", "--quiet", `${value}^{commit}`], {
    cwd: repo.root,
    allowExit: [0, 1, 128],
  });
  const full = check.stdout.trim();
  if (check.code !== 0 || !full) {
    throw new GitError("invalid_hash", `未知提交：${hash}`);
  }
  const parentsResult = await runGit(["show", "-s", "--format=%P", full], { cwd: repo.root });
  return {
    hash: full,
    parents: parentsResult.stdout.trim().split(" ").filter(Boolean),
  };
}

function parseNumstatZ(stdout) {
  const map = new Map();
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (!record) continue;
    const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(record);
    if (!match) continue;
    let filePath = match[3];
    let oldPath = null;
    if (filePath === "") {
      oldPath = tokens[index + 1] ?? "";
      filePath = tokens[index + 2] ?? "";
      index += 2;
    }
    if (!filePath) continue;
    const binary = match[1] === "-" || match[2] === "-";
    map.set(filePath, {
      path: filePath,
      ...(oldPath ? { origPath: oldPath } : {}),
      additions: binary ? null : Number(match[1]),
      deletions: binary ? null : Number(match[2]),
      binary,
    });
  }
  return map;
}

function parseNameStatusZ(stdout) {
  const files = [];
  const tokens = stdout.split("\0");
  for (let index = 0; index < tokens.length; ) {
    const record = tokens[index];
    if (!record) {
      index += 1;
      continue;
    }
    const letter = record[0];
    index += 1;
    if (letter === "R" || letter === "C") {
      const oldPath = tokens[index] ?? "";
      const newPath = tokens[index + 1] ?? "";
      index += 2;
      files.push({ path: newPath, origPath: oldPath, status: letter });
    } else {
      const filePath = tokens[index] ?? "";
      index += 1;
      files.push({ path: filePath, status: letter });
    }
  }
  return files;
}

export async function readCommitDetail(repo, hash) {
  const { hash: full, parents } = await resolveCommit(repo, hash);
  const metaResult = await runGit(
    ["show", "-s", "--format=%H%x1f%P%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%cI%x1f%B", full],
    { cwd: repo.root }
  );
  const fields = metaResult.stdout.replace(/\n$/, "").split("\x1f", 8);
  const [fullHash, parentField, author, email, authoredAt, committer, committedAt, body] = fields;
  const message = body ?? "";
  const firstLineBreak = message.indexOf("\n");
  const subject = firstLineBreak === -1 ? message : message.slice(0, firstLineBreak);
  const rest = firstLineBreak === -1 ? "" : message.slice(firstLineBreak + 1).trim();

  const diffBase = parents.length > 0 ? parents[0] : null;
  const numstatArgs = diffBase
    ? ["diff", "--numstat", "-z", "-M", diffBase, full]
    : ["diff-tree", "--root", "--no-commit-id", "--numstat", "-r", "-M", "-z", full];
  const nameStatusArgs = diffBase
    ? ["diff", "--name-status", "-z", "-M", diffBase, full]
    : ["diff-tree", "--root", "--no-commit-id", "--name-status", "-r", "-M", "-z", full];

  const [numstatResult, nameStatusResult] = await Promise.all([
    runGit(numstatArgs, { cwd: repo.root }),
    runGit(nameStatusArgs, { cwd: repo.root }),
  ]);

  const stats = parseNumstatZ(numstatResult.stdout);
  const entries = parseNameStatusZ(nameStatusResult.stdout);
  let truncated = false;
  const files = entries.slice(0, MAX_COMMIT_FILES).map((item) => {
    const stat = stats.get(item.path);
    return {
      path: item.path,
      ...(item.origPath ? { origPath: item.origPath } : {}),
      status: item.status,
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
      binary: stat?.binary ?? false,
    };
  });
  if (entries.length > MAX_COMMIT_FILES) truncated = true;

  let additions = 0;
  let deletions = 0;
  for (const file of files) {
    if (typeof file.additions === "number") additions += file.additions;
    if (typeof file.deletions === "number") deletions += file.deletions;
  }

  return {
    hash: fullHash || full,
    short: (fullHash || full).slice(0, 7),
    parents,
    author,
    email,
    authoredAt,
    committer,
    committedAt,
    subject,
    body: rest,
    merge: parents.length > 1,
    relativeTo: parents.length > 0 ? "first-parent" : "root",
    files,
    truncated,
    stats: {
      files: files.length,
      additions,
      deletions,
    },
  };
}

function contextValue(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 3;
  return Math.min(Math.max(Math.trunc(parsed), 0), 20);
}

function pathPair(repo, filePath, oldPath) {
  const primary = safeRel(repo, filePath, { allowEmpty: true });
  const paths = primary ? [primary] : [];
  if (oldPath) {
    const original = safeRel(repo, oldPath);
    if (!paths.includes(original)) paths.push(original);
  }
  return { primary, paths };
}

export async function readCommitDiff(repo, { hash, filePath, oldPath, context = 3 } = {}) {
  const { hash: full, parents } = await resolveCommit(repo, hash);
  const { primary, paths } = pathPair(repo, filePath, oldPath);
  if (!primary) throw new GitError("invalid_path", "缺少文件路径");
  const ctx = `-U${contextValue(context)}`;
  // A rename is only detected when both sides are part of the pathspec, so pass
  // the old path from the status/detail entry alongside the new one.
  const args = parents.length > 0
    ? ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", ctx, "-M", parents[0], full, "--", ...paths]
    : ["-c", "core.quotePath=false", "diff-tree", "--root", "-p", "--no-commit-id", "--no-color", "--no-ext-diff", ctx, "-M", full, "--", ...paths];
  const { stdout } = await runGit(args, { cwd: repo.root, maxBuffer: 16 * 1024 * 1024 });
  return { hash: full, path: primary, text: normalizeDiff(stdout) };
}

export async function readWorkingDiff(repo, { scope = "worktree", filePath = null, oldPath = null, context = 3 } = {}) {
  const ctx = `-U${contextValue(context)}`;
  const { primary, paths } = pathPair(repo, filePath, oldPath);

  if (scope === "untracked") {
    if (!primary) throw new GitError("invalid_path", "查看未跟踪文件需要提供路径");
    const result = await runGit(
      ["-c", "core.quotePath=false", "diff", "--no-index", "--no-color", "--no-ext-diff", ctx, "--", "/dev/null", primary],
      { cwd: repo.root, allowExit: [0, 1], maxBuffer: 16 * 1024 * 1024 }
    );
    return { scope, path: primary, text: normalizeDiff(result.stdout) };
  }

  if (scope !== "worktree" && scope !== "staged") {
    throw new GitError("invalid_scope", `未知的 diff 范围：${scope}`);
  }

  const args = ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", ctx, "-M"];
  if (scope === "staged") args.push("--cached");
  if (paths.length > 0) args.push("--", ...paths);

  const { stdout } = await runGit(args, { cwd: repo.root, maxBuffer: 16 * 1024 * 1024 });
  return { scope, path: primary, text: normalizeDiff(stdout) };
}

export function workspaceRoot() {
  const fromEnv = process.env.ZCODE_WORKSPACE_ROOT;
  return fromEnv && fromEnv.trim() ? fromEnv : process.cwd();
}
