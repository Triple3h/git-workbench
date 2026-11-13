import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(here, "..");
const serverPath = path.join(pluginRoot, "server.mjs");

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test User",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test User",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_AUTHOR_DATE: "2026-01-02T03:04:05+08:00",
      GIT_COMMITTER_DATE: "2026-01-02T03:04:05+08:00",
    },
  }).trim();
}

class Client {
  constructor(workspace) {
    this.id = 0;
    this.pending = new Map();
    this.buffer = "";
    this.stderr = "";
    this.proc = spawn(process.execPath, [serverPath], {
      env: { ...process.env, ZCODE_WORKSPACE_ROOT: workspace },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.proc.stdout.setEncoding("utf8");
    this.proc.stdout.on("data", (chunk) => this.onData(chunk));
    this.proc.stderr.setEncoding("utf8");
    this.proc.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  onData(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf("\n")) !== -1) {
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    }
  }

  request(method, params = {}) {
    const id = ++this.id;
    const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout: ${method}\nstderr: ${this.stderr}`));
      }, 20_000);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.proc.stdin.write(`${payload}\n`);
    });
  }

  async tool(name, args = {}) {
    const result = await this.request("tools/call", { name, arguments: args });
    return result;
  }

  close() {
    this.proc.stdin.end();
    this.proc.kill();
  }
}

function toolData(result) {
  if (result.isError) {
    const error = result.structuredContent?.error;
    const failure = new Error(error?.message ?? "tool failed");
    failure.code = error?.code;
    throw failure;
  }
  return result.structuredContent;
}

function toolText(result) {
  return (result.content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

const results = [];
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    results.push({ name, ok: false, error });
    process.stdout.write(`  FAIL ${name}\n${error?.stack ?? error}\n`);
  }
}

async function makeRepo() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "gw-repo-"));
  git(dir, ["init", "-q", "-b", "main"]);
  await mkdir(path.join(dir, "src"), { recursive: true });
  await mkdir(path.join(dir, "docs"), { recursive: true });
  await writeFile(path.join(dir, "README.md"), "# Demo\n\nInitial readme.\n");
  await writeFile(path.join(dir, "src", "app.js"), "export function main() {\n  return 1;\n}\n");
  await writeFile(path.join(dir, "docs", "old name.txt"), "rename me\n");
  await writeFile(path.join(dir, "del.txt"), "delete me\n");
  await writeFile(path.join(dir, "move-me.txt"), "move me\n");
  await writeFile(path.join(dir, "bin.dat"), Buffer.from([0, 1, 2, 3, 0, 255]));
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "init: 初始提交"]);
  git(dir, ["tag", "v0.1.0"]);

  git(dir, ["mv", "docs/old name.txt", "docs/新 名称.txt"]);
  git(dir, ["commit", "-q", "-m", "docs: 重命名文件"]);

  git(dir, ["checkout", "-q", "-b", "feature"]);
  await writeFile(path.join(dir, "src", "feature.js"), "export const feature = true;\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "feat: 增加特性"]);

  git(dir, ["checkout", "-q", "main"]);
  await writeFile(path.join(dir, "src", "app.js"), "export function main() {\n  return 2;\n}\n");
  git(dir, ["commit", "-q", "-am", "fix: 修复问题"]);

  git(dir, ["merge", "--no-ff", "-q", "-m", "merge: 合并 feature", "feature"]);

  git(dir, ["checkout", "-q", "-b", "side", "HEAD~2"]);
  await writeFile(path.join(dir, "side.txt"), "side branch\n");
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", "chore: 侧分支提交"]);
  git(dir, ["checkout", "-q", "main"]);

  // Working tree state: staged new file + staged rename.
  await writeFile(path.join(dir, "staged.txt"), "staged file\n");
  git(dir, ["add", "staged.txt"]);
  git(dir, ["mv", "move-me.txt", "moved.txt"]);

  // Unstaged edits and deletion.
  await writeFile(path.join(dir, "src", "app.js"), "export function main() {\n  return 3;\n}\n");
  await writeFile(path.join(dir, "README.md"), "# Demo\n\nUpdated readme.\n");
  execFileSync("rm", [path.join(dir, "del.txt")]);

  // Untracked files, including unicode and a large file for pagination.
  await writeFile(path.join(dir, "notes.md"), "notes\n");
  await writeFile(path.join(dir, "新文件.txt"), "你好，世界\n");
  const large = Array.from({ length: 4000 }, (_, index) => `line ${index + 1}`).join("\n");
  await writeFile(path.join(dir, "large.txt"), `${large}\n`);

  return dir;
}

async function makeNonRepo() {
  return mkdtemp(path.join(os.tmpdir(), "gw-nonrepo-"));
}

async function main() {
  const repo = await makeRepo();
  const client = new Client(repo);

  try {
    await test("initialize negotiates a supported protocol", async () => {
      const result = await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "smoke", version: "1" },
      });
      assert.equal(result.protocolVersion, "2025-06-18");
      assert.equal(result.serverInfo.name, "git-workbench");
      assert.ok(result.capabilities.tools);
      assert.ok(result.capabilities.resources);
      await client.request("notifications/initialized");
    });

    await test("tools/list exposes only read-only tools", async () => {
      const { tools } = await client.request("tools/list");
      const names = tools.map((tool) => tool.name).sort();
      assert.deepEqual(names, [
        "git_branches",
        "git_commit_detail",
        "git_commit_diff",
        "git_diff",
        "git_log",
        "git_status",
        "open_git_panel",
      ]);
      for (const tool of tools) assert.equal(tool.annotations?.readOnlyHint, true);
      const open = tools.find((tool) => tool.name === "open_git_panel");
      assert.equal(open._meta.ui.surface, "git");
      assert.equal(open._meta.ui.resourceUri, "ui://git-workbench/panel.html");
    });

    await test("resources/read serves the panel as mcp-app html", async () => {
      const result = await client.request("resources/read", {
        uri: "ui://git-workbench/panel.html",
      });
      const content = result.contents[0];
      assert.equal(content.mimeType, "text/html;profile=mcp-app");
      assert.match(content.text, /Git 工作台/);
      const asset = await client.request("resources/read", {
        uri: "ui://git-workbench/assets/panel.css",
      });
      assert.equal(asset.contents[0].mimeType, "text/css; charset=utf-8");
    });

    await test("git_status reports branch and all change groups", async () => {
      const status = toolData(await client.tool("git_status"));
      assert.equal(status.isRepo, true);
      assert.equal(status.branch, "main");
      assert.equal(status.unborn, false);
      assert.ok(status.counts.staged >= 2, `staged=${status.counts.staged}`);
      assert.ok(status.counts.unstaged >= 2, `unstaged=${status.counts.unstaged}`);
      assert.equal(status.counts.untracked, 3);
      const rename = status.groups.staged.find((file) => file.status === "R");
      assert.ok(rename, "rename entry missing");
      assert.equal(rename.path, "moved.txt");
      assert.equal(rename.origPath, "move-me.txt");
      assert.ok(status.groups.untracked.some((file) => file.path === "新文件.txt"));
      assert.ok(status.groups.unstaged.some((file) => file.path === "del.txt" && file.status === "D"));
      assert.ok(status.head?.hash);
    });

    await test("git_log returns topo order with refs and merge parents", async () => {
      const log = toolData(await client.tool("git_log", { limit: 50 }));
      assert.ok(log.commits.length >= 6);
      const merge = log.commits[0];
      assert.match(merge.subject, /merge/);
      assert.equal(merge.parents.length, 2);
      const init = log.commits.find((commit) => commit.subject.startsWith("init:"));
      assert.ok(init.refs.some((ref) => ref.type === "tag" && ref.name === "v0.1.0"));
      assert.ok(log.commits.some((commit) => commit.refs.some((ref) => ref.type === "head")));
      assert.ok(log.commits.some((commit) => commit.refs.some((ref) => ref.type === "branch")));
      assert.ok(log.nextCursor === null);
    });

    await test("git_log filters by branch", async () => {
      const log = toolData(await client.tool("git_log", { branch: "side", limit: 20 }));
      assert.equal(log.commits[0].subject, "chore: 侧分支提交");
      assert.ok(!log.commits.some((commit) => commit.subject.startsWith("merge:")));
    });

    await test("git_log paginates with a cursor", async () => {
      const first = toolData(await client.tool("git_log", { limit: 2 }));
      assert.equal(first.commits.length, 2);
      assert.equal(first.nextCursor, 2);
      const second = toolData(await client.tool("git_log", { limit: 2, cursor: 2 }));
      assert.equal(second.commits.length, 2);
      assert.notEqual(first.commits[0].hash, second.commits[0].hash);
    });

    await test("git_branches lists local, remote and tags", async () => {
      const branches = toolData(await client.tool("git_branches"));
      assert.equal(branches.current, "main");
      const names = branches.local.map((branch) => branch.name);
      assert.ok(names.includes("main"));
      assert.ok(names.includes("feature"));
      assert.ok(names.includes("side"));
      assert.ok(branches.tags.some((tag) => tag.name === "v0.1.0"));
      assert.equal(branches.detached, false);
    });

    await test("git_commit_detail reports root commit files and binary", async () => {
      const log = toolData(await client.tool("git_log", { limit: 50 }));
      const init = log.commits.find((commit) => commit.subject.startsWith("init:"));
      const detail = toolData(await client.tool("git_commit_detail", { hash: init.hash }));
      assert.equal(detail.relativeTo, "root");
      assert.equal(detail.files.length, 6);
      const binary = detail.files.find((file) => file.path === "bin.dat");
      assert.equal(binary.binary, true);
      assert.equal(binary.additions, null);
    });

    await test("git_commit_detail reports rename and first-parent merge", async () => {
      const log = toolData(await client.tool("git_log", { limit: 50 }));
      const renameCommit = log.commits.find((commit) => commit.subject.startsWith("docs:"));
      const rename = toolData(await client.tool("git_commit_detail", { hash: renameCommit.hash }));
      const moved = rename.files.find((file) => file.status === "R");
      assert.ok(moved, "rename file missing");
      assert.equal(moved.path, "docs/新 名称.txt");
      assert.equal(moved.origPath, "docs/old name.txt");

      const renameDiff = await client.tool("git_commit_diff", {
        hash: renameCommit.hash,
        path: moved.path,
        oldPath: moved.origPath,
      });
      assert.match(toolText(renameDiff), /rename from docs\/old name\.txt/);

      const merge = log.commits[0];
      const mergeDetail = toolData(await client.tool("git_commit_detail", { hash: merge.hash }));
      assert.equal(mergeDetail.merge, true);
      assert.equal(mergeDetail.relativeTo, "first-parent");
      assert.ok(mergeDetail.files.length > 0);
    });

    await test("git_diff returns staged, worktree and untracked diffs", async () => {
      const staged = await client.tool("git_diff", {
        scope: "staged",
        path: "moved.txt",
        oldPath: "move-me.txt",
      });
      const stagedText = toolText(staged);
      assert.match(stagedText, /rename from move-me\.txt/);
      assert.equal(toolData(staged).next, null);

      const worktree = await client.tool("git_diff", { scope: "worktree", path: "src/app.js" });
      assert.match(toolText(worktree), /\+  return 3;/);

      const untracked = await client.tool("git_diff", { scope: "untracked", path: "新文件.txt" });
      assert.match(toolText(untracked), /你好，世界/);
      assert.equal(toolData(untracked).empty, false);
    });

    await test("git_diff paginates large diffs", async () => {
      const first = await client.tool("git_diff", { scope: "untracked", path: "large.txt" });
      const firstData = toolData(first);
      assert.ok(firstData.next !== null, "expected a next cursor");
      assert.ok(Buffer.byteLength(toolText(first), "utf8") <= 24 * 1024 + 128);
      const second = await client.tool("git_diff", {
        scope: "untracked",
        path: "large.txt",
        cursor: firstData.next,
      });
      assert.ok(toolText(second).length > 0);
    });

    await test("git_commit_diff returns the file diff for a commit", async () => {
      const log = toolData(await client.tool("git_log", { limit: 50 }));
      const merge = log.commits[0];
      const detail = toolData(await client.tool("git_commit_detail", { hash: merge.hash }));
      const target = detail.files.find((file) => file.path === "src/feature.js") ?? detail.files[0];
      const diff = await client.tool("git_commit_diff", {
        hash: merge.hash,
        path: target.path,
      });
      assert.match(toolText(diff), /^diff --git /m);
      assert.equal(toolData(diff).empty, false);
    });

    await test("invalid commit hash returns a structured error", async () => {
      const result = await client.tool("git_commit_detail", { hash: "zzzz" });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, "invalid_hash");
    });

    await test("path traversal is rejected", async () => {
      const result = await client.tool("git_diff", { scope: "worktree", path: "../etc/passwd" });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, "path_outside_repo");
    });
  } finally {
    client.close();
  }

  const nonRepo = await makeNonRepo();
  const nonRepoClient = new Client(nonRepo);
  try {
    await test("non-repository workspace returns isRepo:false", async () => {
      await nonRepoClient.request("initialize", { protocolVersion: "2025-06-18" });
      const status = toolData(await nonRepoClient.tool("git_status"));
      assert.equal(status.isRepo, false);
      assert.equal(status.root, null);
      const result = await nonRepoClient.tool("git_log");
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent.error.code, "not_a_repo");
    });
  } finally {
    nonRepoClient.close();
  }

  const failed = results.filter((result) => !result.ok);
  process.stdout.write(`\n${results.length - failed.length}/${results.length} passed\n`);
  if (failed.length) {
    for (const failure of failed) process.stdout.write(`\n${failure.name}\n${failure.error?.stack}\n`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
