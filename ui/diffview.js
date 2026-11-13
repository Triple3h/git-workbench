(function () {
  "use strict";

  const GW = (window.GW = window.GW || {});

  const METADATA_PREFIXES = [
    "index ",
    "new file mode",
    "deleted file mode",
    "old mode",
    "new mode",
    "similarity index",
    "dissimilarity index",
    "rename from ",
    "rename to ",
    "copy from ",
    "copy to ",
    "GIT binary patch",
    "literal ",
    "delta ",
  ];

  function cleanPath(value) {
    const text = String(value || "").trim();
    if (!text) return "";
    return text.replace(/^[ab]\//, "");
  }

  GW.renderDiff = function (container, text, options) {
    const opts = options || {};
    container.textContent = "";

    const source = String(text || "").replace(/\r\n/g, "\n");
    if (opts.binary || /^Binary files .+ differ$/m.test(source)) {
      const banner = GW.el("div", "gw-binary");
      banner.append(GW.iconEl("file", 14));
      banner.append(GW.el("span", null, "二进制文件，无法显示文本差异"));
      container.append(banner);
      return { additions: 0, deletions: 0, binary: true };
    }
    if (!source.trim() || opts.empty) {
      container.append(GW.el("div", "gw-diff-empty", "没有可显示的差异"));
      return { additions: 0, deletions: 0, binary: false };
    }

    const root = GW.el("div", "gw-diff");
    container.append(root);

    let block = null;
    let header = null;
    let oldPath = "";
    let newPath = "";
    let inHunk = false;
    let oldNo = 0;
    let newNo = 0;
    let additions = 0;
    let deletions = 0;
    let totalAdditions = 0;
    let totalDeletions = 0;

    function withNumber(value) {
      return value > 0 ? String(value) : "";
    }

    function addRow(kind, sign, oldValue, newValue, content) {
      const row = GW.el("div", `gw-dline${kind ? ` ${kind}` : ""}`);
      row.append(
        GW.el("span", "gw-dno", withNumber(oldValue)),
        GW.el("span", "gw-dno", withNumber(newValue)),
        GW.el("span", "gw-dsign", sign),
        GW.el("span", "gw-dtext", content === "" ? " " : content)
      );
      block.append(row);
    }

    function finalizeBlock() {
      if (!block || !header) return;
      const cleanOld = cleanPath(oldPath);
      const cleanNew = cleanPath(newPath);
      let label;
      if (cleanOld === "/dev/null") label = `${cleanNew}（新增）`;
      else if (cleanNew === "/dev/null") label = `${cleanOld}（删除）`;
      else if (cleanOld && cleanNew && cleanOld !== cleanNew) label = `${cleanOld} → ${cleanNew}`;
      else label = cleanNew || cleanOld;
      const stats = GW.el("span", "gw-file-stats");
      if (additions > 0) stats.append(GW.el("span", "gw-stat-add", `+${additions}`));
      if (deletions > 0) stats.append(GW.el("span", "gw-stat-del", `−${deletions}`));
      header.append(GW.el("span", "gw-dfile-path", label), stats);
      totalAdditions += additions;
      totalDeletions += deletions;
    }

    function startBlock() {
      finalizeBlock();
      block = GW.el("div", "gw-dblock");
      header = GW.el("div", "gw-dfile");
      block.append(header);
      root.append(block);
      oldPath = "";
      newPath = "";
      inHunk = false;
      additions = 0;
      deletions = 0;
    }

    if (!/^diff --git /m.test(source)) startBlock();

    for (const line of source.split("\n")) {
      if (line.startsWith("diff --git ")) {
        startBlock();
        const match = /^diff --git (.+) (.+)$/.exec(line);
        if (match) {
          oldPath = match[1];
          newPath = match[2];
        }
        continue;
      }

      if (METADATA_PREFIXES.some((prefix) => line.startsWith(prefix))) {
        continue;
      }

      if (line.startsWith("--- ")) {
        oldPath = line.slice(4);
        continue;
      }
      if (line.startsWith("+++ ")) {
        newPath = line.slice(4);
        continue;
      }

      if (line.startsWith("@@")) {
        inHunk = true;
        const match = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@+/.exec(line);
        if (match) {
          oldNo = Number(match[1]);
          newNo = Number(match[3]);
        }
        if (!block) startBlock();
        const row = GW.el("div", "gw-dline hunk");
        row.append(
          GW.el("span", "gw-dno", ""),
          GW.el("span", "gw-dno", ""),
          GW.el("span", "gw-dsign", ""),
          GW.el("span", "gw-dtext", line)
        );
        block.append(row);
        continue;
      }

      if (!inHunk) continue;

      if (line.startsWith("\\")) {
        addRow("note", "", 0, 0, line.slice(1).trim());
        continue;
      }

      if (line.startsWith("+")) {
        addRow("add", "+", 0, newNo, line.slice(1));
        newNo += 1;
        additions += 1;
        continue;
      }

      if (line.startsWith("-")) {
        addRow("del", "−", oldNo, 0, line.slice(1));
        oldNo += 1;
        deletions += 1;
        continue;
      }

      if (line.startsWith(" ") || line === "") {
        addRow("", " ", oldNo, newNo, line.slice(1));
        oldNo += 1;
        newNo += 1;
      }
    }

    finalizeBlock();

    return {
      additions: totalAdditions,
      deletions: totalDeletions,
      binary: false,
    };
  };
})();
