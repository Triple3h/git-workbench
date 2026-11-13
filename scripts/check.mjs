import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const failures = [];

async function check(name, fn) {
  try {
    await fn();
    process.stdout.write(`  ok  ${name}\n`);
  } catch (error) {
    failures.push({ name, error });
    process.stdout.write(`  FAIL ${name}\n${error?.message ?? error}\n`);
  }
}

async function exists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

const manifestPath = path.join(root, ".zcode-plugin", "plugin.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const marketplace = JSON.parse(await readFile(path.join(root, "..", "marketplace.json"), "utf8"));
const entry = (marketplace.plugins || []).find((plugin) => plugin.name === manifest.name);

process.stdout.write("Static checks\n");

await check("plugin directory name matches manifest name", () => {
  assert.equal(path.basename(root), manifest.name);
  assert.match(manifest.name, /^[a-z0-9][a-z0-9._-]{0,63}$/);
});

await check("manifest version is semver", () => {
  assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
});

await check("mcpServers declares the surface server", () => {
  const surface = manifest.ui?.surfaces?.[0];
  assert.ok(surface, "ui.surfaces is missing");
  assert.ok(manifest.mcpServers?.[surface.server], `mcpServers.${surface.server} is missing`);
  assert.equal(surface.availability, "session");
  assert.match(surface.resourceUri, /^ui:\/\//);
  assert.ok(surface.resourceUri.length <= 2048);
  assert.equal(surface.icon, "git-branch");
  assert.ok(surface.title?.["zh-CN"] && surface.title?.["en-US"]);
  assert.deepEqual(
    Object.keys(surface).sort(),
    ["availability", "icon", "id", "resourceUri", "server", "title"].sort()
  );
});

await check("manifest paths stay inside the plugin root", () => {
  const serialized = JSON.stringify(manifest);
  const placeholders = [...serialized.matchAll(/\$\{([A-Z_]+)\}/g)].map((match) => match[1]);
  for (const name of placeholders) {
    assert.ok(
      ["CLAUDE_PLUGIN_ROOT", "ZCODE_PROJECT_DIR"].includes(name),
      `unexpected placeholder: ${name}`
    );
  }
});

await check("launcher is executable", async () => {
  const target = path.join(root, "bin", "launch.sh");
  const info = await stat(target);
  assert.ok(info.mode & 0o111, "bin/launch.sh is not executable");
  const source = await readFile(target, "utf8");
  assert.match(source, /ZCODE_PROJECT_DIR|__zcode-plugin-host|node/);
});

await check("required files exist", async () => {
  const files = [
    "server.mjs",
    "bin/launch.sh",
    "lib/mcp.mjs",
    "lib/git.mjs",
    "lib/tools.mjs",
    "lib/diff.mjs",
    "ui/panel.html",
    "ui/panel.css",
    "ui/panel.js",
    "ui/graph.js",
    "ui/diffview.js",
    "ui/changes-view.js",
    "ui/log-view.js",
    "skills/git-workbench/SKILL.md",
    "scripts/smoke.mjs",
  ];
  for (const file of files) {
    assert.ok(await exists(path.join(root, file)), `missing ${file}`);
  }
});

await check("server asset allowlist covers every panel asset", async () => {
  const server = await readFile(path.join(root, "server.mjs"), "utf8");
  for (const name of [
    "panel.css",
    "panel.js",
    "graph.js",
    "diffview.js",
    "changes-view.js",
    "log-view.js",
  ]) {
    assert.ok(server.includes(`["${name}"`), `asset ${name} is not registered`);
    assert.ok(await exists(path.join(root, "ui", name)), `ui/${name} is missing`);
  }
  const panel = await readFile(path.join(root, "ui", "panel.html"), "utf8");
  assert.ok(panel.includes("panel.css"));
  for (const name of ["panel.js", "graph.js", "diffview.js", "changes-view.js", "log-view.js"]) {
    assert.ok(panel.includes(name), `panel.html does not load ${name}`);
  }
  assert.ok(panel.includes("window.zcode"));
  assert.ok(panel.includes("ui://git-workbench/assets/"));
});

await check("skill frontmatter matches the plugin", async () => {
  const skill = await readFile(path.join(root, "skills", "git-workbench", "SKILL.md"), "utf8");
  const match = /^---\n([\s\S]*?)\n---/.exec(skill);
  assert.ok(match, "missing YAML frontmatter");
  assert.match(match[1], /^name: git-workbench$/m);
  assert.match(match[1], /^description: .+/m);
});

await check("marketplace entry points at this plugin", async () => {
  assert.ok(entry, `marketplace has no entry for ${manifest.name}`);
  assert.equal(entry.version, manifest.version);
  assert.equal(entry.source, `./${path.basename(root)}`);
  assert.equal(entry.category, "developer-tools");
  assert.ok(await exists(path.resolve(root, "..", entry.source)));
});

await check("all JavaScript parses", async () => {
  const { readdir } = await import("node:fs/promises");
  const files = [];
  for (const folder of ["lib", "scripts", "ui"]) {
    for (const name of await readdir(path.join(root, folder))) {
      if (name.endsWith(".js") || name.endsWith(".mjs")) files.push(path.join(root, folder, name));
    }
  }
  files.push(path.join(root, "server.mjs"));
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], { encoding: "utf8" });
    assert.equal(result.status, 0, `${path.relative(root, file)}: ${result.stderr}`);
  }
});

await check("read-only guarantee: no git write commands in the server", async () => {
  const sources = await Promise.all(
    ["lib/git.mjs", "lib/tools.mjs", "server.mjs"].map((file) =>
      readFile(path.join(root, file), "utf8")
    )
  );
  const text = sources.join("\n");
  for (const forbidden of ['"add"', '"commit"', '"push"', '"reset"', '"restore"', '"checkout"', '"merge"']) {
    assert.ok(!text.includes(forbidden), `unexpected git write command: ${forbidden}`);
  }
  assert.ok(!/registerTool\(\s*"(stage|commit|push|rollback)/.test(text));
});

if (failures.length > 0) {
  process.stdout.write(`\n${failures.length} check(s) failed\n`);
  process.exit(1);
}
process.stdout.write("\nAll static checks passed\n");
