import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMcpServer } from "./lib/mcp.mjs";
import { createTools, PANEL_URI } from "./lib/tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const uiRoot = path.join(here, "ui");
const ASSET_PREFIX = "ui://git-workbench/assets/";
const HTML_MIME = "text/html;profile=mcp-app";

const ASSETS = new Map([
  ["panel.css", "text/css; charset=utf-8"],
  ["panel.js", "text/plain; charset=utf-8"],
  ["graph.js", "text/plain; charset=utf-8"],
  ["diffview.js", "text/plain; charset=utf-8"],
  ["changes-view.js", "text/plain; charset=utf-8"],
  ["log-view.js", "text/plain; charset=utf-8"],
]);

const PANEL_META = { ui: { permissions: { clipboardWrite: {} } } };

let manifest = { version: "0.1.0", description: "Read-only Git workbench" };
try {
  manifest = JSON.parse(await readFile(path.join(here, ".zcode-plugin", "plugin.json"), "utf8"));
} catch {
  // The server still works if the manifest is unavailable (e.g. copied files).
}

const resources = {
  list() {
    return [
      {
        uri: PANEL_URI,
        name: "panel.html",
        title: "Git Workbench",
        description: "Git Workbench side panel",
        mimeType: HTML_MIME,
        _meta: PANEL_META,
      },
    ];
  },
  async read(uri) {
    if (uri === PANEL_URI) {
      return [
        {
          uri,
          mimeType: HTML_MIME,
          text: await readFile(path.join(uiRoot, "panel.html"), "utf8"),
          _meta: PANEL_META,
        },
      ];
    }
    if (uri.startsWith(ASSET_PREFIX)) {
      const name = decodeURIComponent(uri.slice(ASSET_PREFIX.length));
      const mimeType = ASSETS.get(name);
      if (!mimeType) throw new Error(`Unknown UI asset: ${name}`);
      return [
        {
          uri,
          mimeType,
          text: await readFile(path.join(uiRoot, name), "utf8"),
        },
      ];
    }
    throw new Error(`Unknown resource: ${uri}`);
  },
};

const server = createMcpServer({
  name: "git-workbench",
  version: manifest.version ?? "0.1.0",
  instructions:
    "Read-only Git inspection for the current workspace. Use git_status, git_diff, git_log, git_branches, git_commit_detail and git_commit_diff. No write operations are available. Call open_git_panel when the user wants to browse changes or history visually.",
  tools: createTools(),
  resources,
});

process.stdout.on("error", (error) => {
  if (error?.code === "EPIPE") process.exit(0);
  process.stderr.write(`[git-workbench] stdout error: ${error?.message ?? error}\n`);
});

for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => process.exit(0));
}

process.on("uncaughtException", (error) => {
  process.stderr.write(`[git-workbench] uncaught: ${error?.stack ?? error}\n`);
});
process.on("unhandledRejection", (error) => {
  process.stderr.write(`[git-workbench] unhandled: ${error?.stack ?? error}\n`);
});

server.start();
