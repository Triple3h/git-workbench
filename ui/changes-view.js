(function () {
  "use strict";

  const GW = (window.GW = window.GW || {});
  const el = GW.el;

  const GROUPS = [
    { id: "conflicted", title: "冲突", scope: "worktree", source: "conflicted" },
    { id: "staged", title: "已暂存", scope: "staged", source: "staged" },
    { id: "unstaged", title: "更改", scope: "worktree", source: "unstaged" },
    { id: "untracked", title: "未跟踪", scope: "untracked", source: "untracked" },
  ];

  const SCOPE_LABELS = {
    staged: "已暂存",
    worktree: "工作区",
    untracked: "未跟踪",
  };

  function badgeClass(status) {
    if (status === "?") return "Q";
    if (!status) return "Q";
    return status;
  }

  function splitPath(filePath) {
    const index = filePath.lastIndexOf("/");
    if (index === -1) return { dir: "", base: filePath };
    return { dir: filePath.slice(0, index + 1), base: filePath.slice(index + 1) };
  }

  function baseName(filePath) {
    const index = filePath.lastIndexOf("/");
    return index === -1 ? filePath : filePath.slice(index + 1);
  }

  class ChangesView {
    constructor(options) {
      this.onStatus = options && options.onStatus;
      this.root = el("div", "gw-changes gw-view");
      this.scroll = el("div", "gw-changes-scroll");
      this.drawer = this.buildDrawer();
      this.root.append(this.buildToolbar(), this.scroll, this.drawer.element);
      this.status = null;
      this.signature = "";
      this.refreshing = false;
      this.expanded = new Set(GROUPS.map((group) => group.id));
      this.selected = null;
      this.diffState = null;
      this.diffToken = 0;
      this.drawerHeight = null;
    }

    get element() {
      return this.root;
    }

    buildToolbar() {
      const toolbar = el("div", "gw-toolbar");
      this.summary = el("span", "gw-toolbar-title", "");
      this.expandButton = GW.iconButton("chevronDown", "全部展开", () => {
        this.expanded = new Set(GROUPS.map((group) => group.id));
        this.render();
      }, 14);
      this.collapseButton = GW.iconButton("chevronRight", "全部折叠", () => {
        this.expanded = new Set();
        this.render();
      }, 14);
      toolbar.append(
        this.summary,
        el("div", "gw-toolbar-spacer"),
        this.expandButton,
        this.collapseButton
      );
      return toolbar;
    }

    buildDrawer() {
      const drawer = el("div", "gw-drawer");
      drawer.hidden = true;

      const resizer = el("div", "gw-drawer-resizer");
      resizer.addEventListener("pointerdown", (event) => this.startResize(event));

      const header = el("div", "gw-drawer-header");
      this.drawerBadge = el("span", "gw-badge", "");
      this.drawerTitle = el("span", "gw-drawer-title", "");
      this.drawerScope = el("span", "gw-drawer-scope", "");
      const spacer = el("div", "gw-drawer-spacer");
      const copyButton = GW.iconButton("copy", "复制路径", () => {
        if (this.selected) GW.copyWithToast(this.selected.path, "路径");
      }, 14);
      const closeButton = GW.iconButton("close", "关闭（Esc）", () => this.closeDrawer(), 14);
      header.append(this.drawerBadge, this.drawerTitle, this.drawerScope, spacer, copyButton, closeButton);

      const body = el("div", "gw-drawer-body");
      const footer = el("div", "gw-drawer-footer");
      this.diffInfo = el("span", null, "");
      this.loadMoreButton = GW.el("button", "gw-link-btn", "加载更多");
      this.loadMoreButton.type = "button";
      this.loadMoreButton.hidden = true;
      this.loadMoreButton.addEventListener("click", () => this.loadDiff({ reset: false }));
      footer.append(this.diffInfo, el("div", "gw-toolbar-spacer"), this.loadMoreButton);

      drawer.append(resizer, header, body, footer);
      return { element: drawer, body };
    }

    startResize(event) {
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = this.drawer.element.getBoundingClientRect().height;
      const maxHeight = this.root.clientHeight * 0.72;
      const move = (moveEvent) => {
        const next = Math.min(Math.max(startHeight + (startY - moveEvent.clientY), 120), maxHeight);
        this.drawerHeight = next;
        this.drawer.element.style.height = `${next}px`;
      };
      const up = () => {
        window.removeEventListener("pointermove", move);
        window.removeEventListener("pointerup", up);
      };
      window.addEventListener("pointermove", move);
      window.addEventListener("pointerup", up);
    }

    async activate() {
      await this.refresh({ silent: true });
    }

    async refresh(options) {
      const silent = !!(options && options.silent);
      if (this.refreshing) return;
      this.refreshing = true;
      try {
        const result = await GW.call("git_status", {});
        const status = result.structured;
        this.status = status;
        if (this.onStatus) this.onStatus(status);
        const signature = JSON.stringify(status);
        if (signature !== this.signature) {
          this.signature = signature;
          this.render();
        }
      } catch (error) {
        if (!silent) GW.toast(error.message || "读取 Git 状态失败", "error");
        if (!this.status) this.renderError(error);
      } finally {
        this.refreshing = false;
      }
    }

    render() {
      const status = this.status;
      this.scroll.textContent = "";
      if (!status) return;

      if (!status.isRepo) {
        this.summary.textContent = "";
        this.renderEmpty({
          icon: "branch",
          title: "当前工作区不是 Git 仓库",
          detail: [
            "Git 工作台是只读查看器，不会替你初始化仓库。",
            "工作区：",
          ],
          workspace: status.workspace,
        });
        this.closeDrawer();
        return;
      }

      const total =
        (status.counts.staged || 0) +
        (status.counts.unstaged || 0) +
        (status.counts.untracked || 0) +
        (status.counts.conflicted || 0);
      this.summary.textContent = total > 0 ? `${total} 个文件` : "";

      if (status.truncated) {
        const banner = el("div", "gw-banner warn");
        banner.append(
          GW.iconEl("alert", 13),
          el("span", null, "变更数量过多，仅显示前 2000 项。")
        );
        this.scroll.append(banner);
      }

      if (status.unborn) {
        const banner = el("div", "gw-banner");
        banner.append(GW.iconEl("history", 13), el("span", null, "仓库还没有任何提交。"));
        this.scroll.append(banner);
      }

      const groups = GROUPS.map((group) => ({
        ...group,
        files: (status.groups && status.groups[group.source]) || [],
      })).filter((group) => group.files.length > 0);

      if (total === 0) {
        const head = status.head;
        this.renderEmpty({
          icon: "commit",
          title: "工作区干净",
          detail: [
            status.unborn
              ? "暂存或创建文件后，变更会显示在这里。"
              : `当前分支 ${status.detached ? "HEAD（游离）" : status.branch || "未知"}`,
            head ? `最新提交 ${head.hash.slice(0, 7)} · ${head.subject}` : "",
          ].filter(Boolean),
        });
        this.closeDrawer();
        return;
      }

      for (const group of groups) {
        const section = el("div", `gw-group${this.expanded.has(group.id) ? "" : " collapsed"}`);
        const header = el("div", "gw-group-header");
        header.append(
          GW.iconEl("chevronDown", 12, "gw-chevron"),
          el("span", "gw-group-title", group.title),
          el("span", "gw-group-count", String(group.files.length))
        );
        header.addEventListener("click", () => {
          if (this.expanded.has(group.id)) this.expanded.delete(group.id);
          else this.expanded.add(group.id);
          section.classList.toggle("collapsed");
        });

        const groupBody = el("div", "gw-group-body");
        for (const file of group.files) groupBody.append(this.renderFile(group, file));
        section.append(header, groupBody);
        this.scroll.append(section);
      }

      this.restoreSelection(groups);
    }

    renderFile(group, file) {
      const key = `${group.scope}:${file.path}`;
      const row = el("div", "gw-file");
      row.dataset.key = key;
      row.tabIndex = 0;
      row.title = file.origPath ? `${file.origPath} → ${file.path}` : file.path;

      const badge = el("span", `gw-badge gw-badge-${badgeClass(file.status)}`, file.status || "?");
      const { dir, base } = splitPath(file.path);
      const pathBox = el("span", "gw-file-path");
      if (dir) pathBox.append(el("span", "gw-file-dir", dir));
      pathBox.append(el("span", "gw-file-base", base));
      if (file.origPath) {
        pathBox.append(el("span", "gw-file-orig", `← ${baseName(file.origPath)}`));
      }

      const actions = el("span", "gw-row-actions");
      const copyButton = GW.iconButton("copy", "复制路径", (event) => {
        event.stopPropagation();
        GW.copyWithToast(file.path, "路径");
      }, 13);
      actions.append(copyButton);

      row.append(badge, pathBox, actions);
      row.addEventListener("click", () => this.select(group, file));
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          this.select(group, file);
        }
      });
      return row;
    }

    renderEmpty(spec) {
      const empty = el("div", "gw-empty");
      const icon = el("div", "gw-empty-icon");
      icon.append(GW.iconEl(spec.icon || "commit", 20));
      empty.append(icon, el("div", "gw-empty-title", spec.title || ""));
      const detail = el("div", "gw-empty-detail");
      for (const line of spec.detail || []) {
        const paragraph = el("div");
        paragraph.textContent = line;
        detail.append(paragraph);
      }
      if (spec.workspace) {
        const code = el("code", null, spec.workspace);
        const paragraph = el("div");
        paragraph.append(code);
        detail.append(paragraph);
      }
      empty.append(detail);
      this.scroll.append(empty);
    }

    renderError(error) {
      this.scroll.textContent = "";
      const empty = el("div", "gw-empty");
      const icon = el("div", "gw-empty-icon");
      icon.append(GW.iconEl("alert", 20));
      empty.append(
        icon,
        el("div", "gw-empty-title", "读取 Git 状态失败"),
        el("div", "gw-empty-detail", error && error.message ? error.message : String(error))
      );
      const retry = el("button", "gw-btn", "重试");
      retry.type = "button";
      retry.addEventListener("click", () => this.refresh({ silent: false }));
      empty.append(retry);
      this.scroll.append(empty);
    }

    restoreSelection(groups) {
      if (!this.selected) return;
      const exists = groups.some(
        (group) =>
          group.scope === this.selected.scope &&
          group.files.some((file) => file.path === this.selected.path)
      );
      if (!exists) {
        this.closeDrawer();
        return;
      }
      this.markSelection();
      this.drawerTitle.textContent = this.selected.path;
    }

    markSelection() {
      const key = this.selected ? this.selected.key : null;
      for (const row of this.scroll.querySelectorAll(".gw-file")) {
        row.classList.toggle("selected", row.dataset.key === key);
      }
    }

    select(group, file) {
      this.selected = {
        key: `${group.scope}:${file.path}`,
        scope: group.scope,
        path: file.path,
        origPath: file.origPath || null,
        status: file.status,
      };
      this.markSelection();
      this.openDrawer();
      this.loadDiff({ reset: true });
    }

    openDrawer() {
      if (!this.selected) return;
      this.drawer.element.hidden = false;
      if (this.drawerHeight) {
        this.drawer.element.style.height = `${this.drawerHeight}px`;
      }
      this.drawerBadge.className = `gw-badge gw-badge-${badgeClass(this.selected.status)}`;
      this.drawerBadge.textContent = this.selected.status || "?";
      this.drawerTitle.textContent = this.selected.path;
      this.drawerTitle.title = this.selected.path;
      this.drawerScope.textContent = SCOPE_LABELS[this.selected.scope] || this.selected.scope;
      this.loadMoreButton.hidden = true;
      this.diffInfo.textContent = "";
    }

    async loadDiff(options) {
      const reset = !options || options.reset !== false;
      if (!this.selected) return;
      const token = ++this.diffToken;
      const cursor = reset ? 0 : this.diffState && this.diffState.next != null ? this.diffState.next : 0;

      if (reset) {
        this.drawer.body.textContent = "";
        this.drawer.body.append(el("div", "gw-diff-loading", "正在读取 diff…"));
        this.diffState = null;
      }

      try {
        const result = await GW.call("git_diff", {
          scope: this.selected.scope,
          path: this.selected.path,
          ...(this.selected.origPath ? { oldPath: this.selected.origPath } : {}),
          cursor,
        });
        if (token !== this.diffToken) return;
        const structured = result.structured || {};
        const incoming = result.text || "";
        const text = reset
          ? incoming
          : `${(this.diffState && this.diffState.text) || ""}${incoming ? `\n${incoming}` : ""}`;
        this.diffState = {
          text,
          next: structured.next == null ? null : structured.next,
          totalLines: structured.totalLines || 0,
          binary: !!structured.binary,
          empty: !!structured.empty,
        };
        this.renderDiffBody();
      } catch (error) {
        if (token !== this.diffToken) return;
        this.drawer.body.textContent = "";
        const box = el("div", "gw-empty");
        box.append(
          el("div", "gw-empty-title", "读取 diff 失败"),
          el("div", "gw-empty-detail", error.message || String(error))
        );
        this.drawer.body.append(box);
        this.diffInfo.textContent = "";
        this.loadMoreButton.hidden = true;
      }
    }

    renderDiffBody() {
      if (!this.diffState) return;
      this.drawer.body.textContent = "";
      const stats = GW.renderDiff(this.drawer.body, this.diffState.text, {
        binary: this.diffState.binary,
        empty: this.diffState.empty,
      });
      const blocks = this.drawer.body.querySelectorAll(".gw-dblock");
      if (blocks.length === 1) {
        const header = blocks[0].querySelector(".gw-dfile");
        if (header) header.hidden = true;
      }

      const parts = [];
      if (stats.binary) parts.push("二进制文件");
      else parts.push(`${this.diffState.totalLines || 0} 行`);
      if (stats.additions) parts.push(`+${stats.additions}`);
      if (stats.deletions) parts.push(`−${stats.deletions}`);
      this.diffInfo.textContent = parts.join(" · ");

      const more = this.diffState.next != null;
      this.loadMoreButton.hidden = !more;
      if (more) {
        this.diffInfo.textContent += ` · 已显示部分内容`;
      }
    }

    closeDrawer() {
      this.diffToken += 1;
      this.selected = null;
      this.diffState = null;
      this.drawer.element.hidden = true;
      this.drawer.body.textContent = "";
      this.diffInfo.textContent = "";
      this.loadMoreButton.hidden = true;
      this.markSelection();
    }

    handleEscape() {
      if (this.drawer.element.hidden) return false;
      this.closeDrawer();
      return true;
    }

    destroy() {
      this.closeDrawer();
    }
  }

  GW.ChangesView = ChangesView;
})();
