(function () {
  "use strict";

  const GW = (window.GW = window.GW || {});
  const el = GW.el;

  function badgeClass(status) {
    return status || "M";
  }

  function splitPath(filePath) {
    const index = String(filePath).lastIndexOf("/");
    if (index === -1) return { dir: "", base: filePath };
    return { dir: filePath.slice(0, index + 1), base: filePath.slice(index + 1) };
  }

  function markText(text, query) {
    const source = String(text || "");
    if (!query) return document.createTextNode(source);
    const lower = source.toLowerCase();
    const needle = query.toLowerCase();
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    while (cursor < source.length) {
      const found = lower.indexOf(needle, cursor);
      if (found === -1) {
        fragment.append(document.createTextNode(source.slice(cursor)));
        break;
      }
      if (found > cursor) fragment.append(document.createTextNode(source.slice(cursor, found)));
      const mark = document.createElement("mark");
      mark.textContent = source.slice(found, found + needle.length);
      fragment.append(mark);
      cursor = found + needle.length;
    }
    return fragment;
  }

  function commitHaystack(commit) {
    return [
      commit.subject,
      commit.author,
      commit.short,
      commit.hash,
      ...(commit.refs || []).map((ref) => ref.name),
    ]
      .join(" ")
      .toLowerCase();
  }

  function refLabel(ref) {
    if (ref.type === "head" && ref.name !== "HEAD") return `HEAD → ${ref.name}`;
    return ref.name;
  }

  function branchNameBox(name) {
    const text = String(name || "");
    const index = text.indexOf("/");
    const box = el("span", "gw-branch-name");
    if (index === -1) {
      box.textContent = text;
      return box;
    }
    box.append(
      el("span", "gw-branch-prefix", text.slice(0, index + 1)),
      document.createTextNode(text.slice(index + 1))
    );
    return box;
  }

  class LogView {
    constructor(options) {
      this.getStatus = options && options.getStatus;
      this.root = el("div", "gw-log gw-view");
      this.root.append(this.buildFilters());

      this.body = el("div", "gw-log-body");
      this.branches = this.buildBranches();
      this.commits = el("div", "gw-commits");
      this.commits.tabIndex = 0;
      this.commits.setAttribute("role", "listbox");
      this.detail = this.buildDetail();
      this.diffDrawer = this.buildDiffDrawer();
      this.body.append(this.branches.element, this.commits, this.detail.element);
      this.root.append(this.body, this.diffDrawer.element);

      this.loaded = false;
      this.loadedAt = 0;
      this.loading = false;
      this.loadingMore = false;
      this.commitsData = [];
      this.nextCursor = null;
      this.filter = "all";
      this.branchData = null;
      this.branchQuery = "";
      this.collapsed = new Set();
      this.selectedHash = null;
      this.detailCache = new Map();
      this.diffCache = new Map();
      this.fileKey = null;
      this.diffState = null;
      this.diffToken = 0;
      this.query = "";
      this.authorQuery = "";
      this.matches = [];

      this.commits.addEventListener("keydown", (event) => this.onCommitKey(event));
    }

    get element() {
      return this.root;
    }

    /* ------------------------------------------------------------------ */
    /* Filters                                                            */
    /* ------------------------------------------------------------------ */

    buildFilters() {
      const bar = el("div", "gw-filters");

      this.branchToggle = GW.iconButton("branch", "分支列表", () => {
        this.root.classList.toggle("branches-open");
      }, 15);
      this.branchToggle.classList.add("gw-branches-toggle");

      const searchField = el("label", "gw-field gw-field-search");
      searchField.append(GW.iconEl("search", 13));
      this.searchInput = el("input");
      this.searchInput.type = "text";
      this.searchInput.placeholder = "搜索提交或哈希";
      this.searchInput.spellcheck = false;
      this.searchInput.setAttribute("aria-label", "搜索提交或哈希");
      this.searchInput.addEventListener("input", GW.debounce(() => this.onSearch(), 120));
      this.searchInput.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          this.jumpToNextMatch();
        } else if (event.key === "Escape" && this.query) {
          event.preventDefault();
          this.clearSearch();
        }
      });
      this.searchCount = el("span", "gw-count-pill", "");
      this.searchClear = el("button", "gw-search-clear");
      this.searchClear.type = "button";
      this.searchClear.title = "清除搜索";
      this.searchClear.innerHTML = GW.icon("close", 11);
      this.searchClear.hidden = true;
      this.searchClear.addEventListener("click", () => this.clearSearch());
      searchField.append(this.searchInput, this.searchCount, this.searchClear);

      const authorField = el("label", "gw-field gw-field-author");
      authorField.append(GW.iconEl("user", 13));
      this.authorInput = el("input");
      this.authorInput.type = "text";
      this.authorInput.placeholder = "作者";
      this.authorInput.spellcheck = false;
      this.authorInput.setAttribute("aria-label", "按作者筛选");
      this.authorInput.addEventListener("input", GW.debounce(() => this.onAuthor(), 120));
      this.authorInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && this.authorQuery) {
          event.preventDefault();
          this.authorInput.value = "";
          this.onAuthor();
        }
      });
      authorField.append(this.authorInput);

      const selectField = el("div", "gw-field gw-field-select");
      this.branchSelect = el("select", null);
      this.branchSelect.title = "按分支筛选";
      this.branchSelect.setAttribute("aria-label", "按分支筛选");
      this.branchSelect.addEventListener("change", () => this.setFilter(this.branchSelect.value));
      selectField.append(this.branchSelect, GW.iconEl("chevronDown", 12, "gw-field-caret"));

      bar.append(this.branchToggle, searchField, authorField, selectField);
      return bar;
    }

    onSearch() {
      this.query = this.searchInput.value.trim();
      this.searchClear.hidden = !this.query;
      this.renderList();
    }

    onAuthor() {
      this.authorQuery = this.authorInput.value.trim().toLowerCase();
      this.renderList();
    }

    clearSearch() {
      this.searchInput.value = "";
      this.query = "";
      this.searchClear.hidden = true;
      this.searchCount.textContent = "";
      this.renderList();
    }

    jumpToNextMatch() {
      if (!this.matches.length) return;
      const current = this.matches.indexOf(this.selectedHash);
      const next = this.matches[(current + 1) % this.matches.length];
      this.select(next);
      const row = this.commits.querySelector(`[data-hash="${next}"]`);
      if (row) row.scrollIntoView({ block: "center" });
    }

    /* ------------------------------------------------------------------ */
    /* Branches                                                           */
    /* ------------------------------------------------------------------ */

    buildBranches() {
      const pane = el("div", "gw-branches");
      const searchBox = el("div", "gw-branch-search");
      const search = el("div", "gw-search");
      search.append(GW.iconEl("search", 12));
      this.branchSearchInput = el("input");
      this.branchSearchInput.type = "text";
      this.branchSearchInput.placeholder = "筛选分支";
      this.branchSearchInput.spellcheck = false;
      this.branchSearchInput.addEventListener(
        "input",
        GW.debounce(() => {
          this.branchQuery = this.branchSearchInput.value.trim().toLowerCase();
          this.renderBranches();
        }, 100)
      );
      search.append(this.branchSearchInput);
      searchBox.append(search);

      this.branchRows = el("div", "gw-branch-rows");
      pane.append(searchBox, this.branchRows);
      return { element: pane };
    }

    renderBranches() {
      const data = this.branchData || {};
      this.branchRows.textContent = "";
      const query = this.branchQuery;

      const matches = (name) => !query || String(name).toLowerCase().includes(query);

      const allRow = el("div", `gw-branch-all${this.filter === "all" ? " active" : ""}`);
      allRow.append(GW.iconEl("list", 13), el("span", null, "所有分支"));
      allRow.addEventListener("click", () => this.setFilter("all"));
      this.branchRows.append(allRow);

      const current = data.current;
      if (current) {
        const headRow = el("div", `gw-branch-row${this.filter === "HEAD" ? " active" : ""} current`);
        headRow.append(GW.iconEl("branch", 13, "gw-branch-icon"));
        headRow.append(el("span", "gw-branch-name", `HEAD → ${current}`));
        headRow.title = "只看当前分支";
        headRow.addEventListener("click", () => this.setFilter("HEAD"));
        this.branchRows.append(headRow);
      }

      const section = (id, title, items, renderItem) => {
        if (!items || !items.length) return;
        const visible = items.filter((item) => matches(item.name));
        if (query && visible.length === 0) return;
        const collapsed = this.collapsed.has(id) && !query;
        const wrapper = el("div", `gw-branch-section${collapsed ? " collapsed" : ""}`);
        const header = el("div", "gw-branch-header");
        header.append(
          GW.iconEl("chevronDown", 11, "gw-chevron"),
          el("span", null, title),
          el("span", "gw-count-pill", String(items.length))
        );
        header.addEventListener("click", () => {
          if (this.collapsed.has(id)) this.collapsed.delete(id);
          else this.collapsed.add(id);
          wrapper.classList.toggle("collapsed");
        });
        const rows = el("div", "gw-branch-rows");
        for (const item of visible) rows.append(renderItem(item));
        wrapper.append(header, rows);
        this.branchRows.append(wrapper);
      };

      const branchRow = (item) => {
        const active = this.filter === item.name || (this.filter === "HEAD" && item.current);
        const row = el("div", `gw-branch-row${active ? " active" : ""}${item.current ? " current" : ""}`);
        row.append(GW.iconEl("branch", 13, "gw-branch-icon"));
        row.append(branchNameBox(item.name));
        if (item.ahead || item.behind) {
          row.append(
            el("span", "gw-branch-track", `${item.ahead ? `↑${item.ahead}` : ""}${item.behind ? `↓${item.behind}` : ""}`)
          );
        }
        row.title = item.name;
        row.addEventListener("click", () => this.setFilter(item.name));
        return row;
      };

      const tagRow = (item) => {
        const row = el("div", `gw-branch-row${this.filter === item.name ? " active" : ""}`);
        row.append(GW.iconEl("tag", 12, "gw-branch-icon"));
        row.append(el("span", "gw-branch-name", item.name));
        row.title = item.name;
        row.addEventListener("click", () => this.setFilter(item.name));
        return row;
      };

      section("local", "本地", data.local, branchRow);
      section("remote", "远程", data.remote, branchRow);
      section("tags", "标签", data.tags, tagRow);
    }

    buildFilterOptions() {
      const data = this.branchData || {};
      const previous = this.filter;
      this.branchSelect.textContent = "";

      const add = (value, label) => {
        const option = el("option", null, label);
        option.value = value;
        this.branchSelect.append(option);
      };

      add("all", "所有分支");
      if (data.current) add("HEAD", `当前：${data.current}`);

      if (data.local && data.local.length) {
        const group = document.createElement("optgroup");
        group.label = "本地";
        for (const item of data.local) {
          const option = el("option", null, item.name);
          option.value = item.name;
          group.append(option);
        }
        this.branchSelect.append(group);
      }
      if (data.remote && data.remote.length) {
        const group = document.createElement("optgroup");
        group.label = "远程";
        for (const item of data.remote) {
          const option = el("option", null, item.name);
          option.value = item.name;
          group.append(option);
        }
        this.branchSelect.append(group);
      }
      if (data.tags && data.tags.length) {
        const group = document.createElement("optgroup");
        group.label = "标签";
        for (const item of data.tags) {
          const option = el("option", null, item.name);
          option.value = item.name;
          group.append(option);
        }
        this.branchSelect.append(group);
      }

      const values = Array.from(this.branchSelect.options).map((option) => option.value);
      if (values.includes(previous)) this.branchSelect.value = previous;
      else {
        this.filter = "all";
        this.branchSelect.value = "all";
      }
    }

    async setFilter(value) {
      if (value === this.filter) {
        this.root.classList.remove("branches-open");
        return;
      }
      this.filter = value;
      this.branchSelect.value = value;
      this.root.classList.remove("branches-open");
      this.selectedHash = null;
      this.loaded = false;
      await this.reload();
    }

    /* ------------------------------------------------------------------ */
    /* Data                                                               */
    /* ------------------------------------------------------------------ */

    async activate(options) {
      const force = !!(options && options.force);
      if (!force && this.loaded && Date.now() - this.loadedAt < 10_000) return;
      await this.reload();
    }

    async reload() {
      if (this.loading) return;
      const status = this.getStatus && this.getStatus();
      if (status && status.isRepo === false) {
        this.renderNonRepo(status.workspace);
        this.loaded = true;
        this.loadedAt = Date.now();
        return;
      }

      this.loading = true;
      let retry = false;
      this.commits.textContent = "";
      this.commits.append(el("div", "gw-list-empty", "正在读取提交记录…"));
      try {
        const logResult = await GW.call("git_log", {
          limit: 120,
          cursor: 0,
          branch: this.filter === "all" ? "all" : this.filter,
        });
        const log = logResult.structured || {};
        this.commitsData = log.commits || [];
        this.nextCursor = log.nextCursor == null ? null : log.nextCursor;
        this.unborn = !!log.unborn;

        try {
          const branchResult = await GW.call("git_branches", {});
          this.branchData = branchResult.structured || {};
        } catch {
          this.branchData = this.branchData || {};
        }

        this.loaded = true;
        this.loadedAt = Date.now();
        this.buildFilterOptions();
        this.renderBranches();
        this.renderList();

        if (this.selectedHash && this.commitsData.some((commit) => commit.hash === this.selectedHash)) {
          await this.select(this.selectedHash, { force: true, scroll: false, reveal: false });
        } else if (this.commitsData.length > 0) {
          await this.select(this.commitsData[0].hash, { scroll: false, reveal: false });
        } else {
          this.clearDetail();
        }
      } catch (error) {
        if (error && error.code === "invalid_ref" && this.filter !== "all") {
          this.filter = "all";
          this.branchSelect.value = "all";
          retry = true;
        } else {
          this.renderError(error);
        }
      } finally {
        this.loading = false;
        if (retry) this.reload();
      }
    }

    async loadMore() {
      if (this.loadingMore || this.nextCursor == null) return;
      this.loadingMore = true;
      try {
        const result = await GW.call("git_log", {
          limit: 120,
          cursor: this.nextCursor,
          branch: this.filter === "all" ? "all" : this.filter,
        });
        const structured = result.structured || {};
        const fresh = structured.commits || [];
        const seen = new Set(this.commitsData.map((commit) => commit.hash));
        for (const commit of fresh) if (!seen.has(commit.hash)) this.commitsData.push(commit);
        this.nextCursor = structured.nextCursor == null ? null : structured.nextCursor;
        this.renderList();
      } catch (error) {
        GW.toast(error.message || "加载更多失败", "error");
      } finally {
        this.loadingMore = false;
      }
    }

    /* ------------------------------------------------------------------ */
    /* Commit list                                                        */
    /* ------------------------------------------------------------------ */

    renderList() {
      const scrollTop = this.commits.scrollTop;
      this.commits.textContent = "";
      this.matches = [];

      if (this.commitsData.length === 0) {
        const filtering = Boolean(this.query || this.authorQuery);
        const empty = el("div", "gw-list-empty");
        empty.append(
          el("div", null, this.unborn ? "仓库还没有提交" : filtering ? "没有匹配的提交" : "没有提交"),
          el(
            "div",
            null,
            this.unborn ? "创建第一个提交后，记录会显示在这里。" : filtering ? "换个关键词试试。" : "当前筛选下没有提交。"
          )
        );
        this.commits.append(empty);
        this.searchCount.textContent = filtering ? "0 个匹配" : "";
        return;
      }

      const graph = GW.computeGraph(this.commitsData, {
        rowHeight: 34,
        laneWidth: 14,
        maxLanes: 8,
      });

      const query = this.query.toLowerCase();
      const authorQuery = this.authorQuery;
      for (let index = 0; index < this.commitsData.length; index += 1) {
        const commit = this.commitsData[index];
        const row = el("div", "gw-commit");
        row.dataset.hash = commit.hash;
        row.setAttribute("role", "option");

        const matched =
          (!query || commitHaystack(commit).includes(query)) &&
          (!authorQuery || String(commit.author || "").toLowerCase().includes(authorQuery));
        if ((query || authorQuery) && matched) this.matches.push(commit.hash);
        if ((query || authorQuery) && !matched) row.classList.add("dim");
        if (commit.hash === this.selectedHash) row.classList.add("selected");

        const graphBox = el("div", "gw-graph");
        graphBox.style.width = `${graph.width}px`;
        graphBox.innerHTML = graph.rows[index] ? graph.rows[index].svg : "";

        const refs = el("div", "gw-refs");
        const list = commit.refs || [];
        if (list.length) {
          const first = list[0];
          const chip = el("span", `gw-ref ${first.type}`, refLabel(first));
          chip.title = list.map((ref) => refLabel(ref)).join(", ");
          refs.append(chip);
        }
        if (list.length > 1) {
          const more = el("span", "gw-ref", `+${list.length - 1}`);
          more.title = list.map((ref) => refLabel(ref)).join(", ");
          refs.append(more);
        }

        const main = el("div", "gw-commit-main");
        const subject = el("div", "gw-subject");
        subject.append(markText(commit.subject, this.query));
        subject.title = commit.subject;
        main.append(subject);

        const author = el("div", "gw-commit-author");
        author.append(GW.avatar(commit.author, 18), el("span", "gw-commit-author-name", commit.author));
        author.title = commit.author;

        const time = el("div", "gw-commit-time", GW.fmtRel(commit.date));
        time.title = GW.fmtDate(commit.date);

        const hash = el("div", "gw-commit-hash", commit.short);
        hash.title = commit.hash;

        row.append(graphBox, refs, main, author, time, hash);
        row.addEventListener("click", () => this.select(commit.hash));
        this.commits.append(row);
      }

      this.searchCount.textContent = this.query || this.authorQuery ? `${this.matches.length} 个匹配` : "";

      if (this.nextCursor != null) {
        const more = el("button", "gw-load-more", this.loadingMore ? "正在加载…" : "加载更多提交");
        more.type = "button";
        more.addEventListener("click", () => this.loadMore());
        this.commits.append(more);
      }

      this.commits.scrollTop = scrollTop;
    }

    onCommitKey(event) {
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      if (!this.commitsData.length) return;
      event.preventDefault();
      const current = this.commitsData.findIndex((commit) => commit.hash === this.selectedHash);
      const delta = event.key === "ArrowDown" ? 1 : -1;
      const next = Math.min(Math.max(current + delta, 0), this.commitsData.length - 1);
      const commit = this.commitsData[next];
      if (!commit) return;
      this.select(commit.hash);
      const row = this.commits.querySelector(`[data-hash="${commit.hash}"]`);
      if (row) row.scrollIntoView({ block: "nearest" });
    }

    renderNonRepo(workspace) {
      this.commits.textContent = "";
      const empty = el("div", "gw-list-empty");
      empty.append(
        el("div", null, "当前工作区不是 Git 仓库"),
        el("div", null, "在包含 .git 的工作区中打开此面板。")
      );
      if (workspace) {
        const code = el("code", null, workspace);
        empty.append(code);
      }
      this.commits.append(empty);
      this.clearDetail();
    }

    renderError(error) {
      this.commits.textContent = "";
      const empty = el("div", "gw-list-empty");
      empty.append(
        el("div", null, "读取提交记录失败"),
        el("div", null, error && error.message ? error.message : String(error))
      );
      const retry = el("button", "gw-btn", "重试");
      retry.type = "button";
      retry.addEventListener("click", () => this.reload());
      empty.append(retry);
      this.commits.append(empty);
      this.clearDetail();
    }

    /* ------------------------------------------------------------------ */
    /* Detail                                                             */
    /* ------------------------------------------------------------------ */

    buildDetail() {
      const element = el("div", "gw-detail");
      const scroll = el("div", "gw-detail-scroll");
      element.append(scroll);
      return { element, scroll };
    }

    buildDiffDrawer() {
      const drawer = el("div", "gw-drawer gw-log-drawer");
      drawer.hidden = true;
      const header = el("div", "gw-drawer-header");
      this.fileBadge = el("span", "gw-badge", "");
      this.fileTitle = el("span", "gw-drawer-title", "");
      const scope = el("span", "gw-drawer-scope", "提交");
      const spacer = el("div", "gw-drawer-spacer");
      const copyButton = GW.iconButton("copy", "复制路径", () => {
        if (this.fileKey) GW.copyWithToast(this.fileKey, "路径");
      }, 13);
      const closeButton = GW.iconButton("close", "关闭 diff（Esc）", () => this.closeFileDiff(), 13);
      header.append(this.fileBadge, this.fileTitle, scope, spacer, copyButton, closeButton);

      const body = el("div", "gw-drawer-body");
      const footer = el("div", "gw-drawer-footer");
      this.fileInfo = el("span", null, "");
      this.fileLoadMore = GW.el("button", "gw-link-btn", "加载更多");
      this.fileLoadMore.type = "button";
      this.fileLoadMore.hidden = true;
      this.fileLoadMore.addEventListener("click", () => this.loadFileDiff({ reset: false }));
      footer.append(this.fileInfo, el("div", "gw-toolbar-spacer"), this.fileLoadMore);
      drawer.append(header, body, footer);
      return { element: drawer, body };
    }

    async select(hash, options) {
      const opts = options || {};
      if (!hash) return;
      if (!opts.force && this.selectedHash === hash) {
        if (opts.reveal !== false) this.root.classList.add("detail-open");
        return;
      }
      this.selectedHash = hash;
      for (const row of this.commits.querySelectorAll(".gw-commit")) {
        row.classList.toggle("selected", row.dataset.hash === hash);
      }
      if (opts.reveal !== false) this.root.classList.add("detail-open");
      this.closeFileDiff();

      const commit = this.commitsData.find((item) => item.hash === hash);
      if (commit && commit.refs) this.currentRefs = commit.refs;
      else this.currentRefs = [];

      this.detail.scroll.textContent = "";
      this.detail.scroll.append(el("div", "gw-detail-empty", "正在读取提交详情…"));

      const cached = this.detailCache.get(hash);
      if (cached) {
        this.renderDetail(cached);
        return;
      }
      try {
        const result = await GW.call("git_commit_detail", { hash });
        if (!result.structured) throw new Error("提交详情为空");
        this.detailCache.set(result.structured.hash || hash, result.structured);
        if (this.selectedHash === hash || result.structured.hash === this.selectedHash) {
          this.renderDetail(result.structured);
        }
      } catch (error) {
        this.detail.scroll.textContent = "";
        const empty = el("div", "gw-detail-empty");
        empty.append(
          el("div", null, "读取提交详情失败"),
          el("div", null, error.message || String(error))
        );
        this.detail.scroll.append(empty);
      }
    }

    renderDetail(detail) {
      this.currentDetail = detail;
      this.detail.scroll.textContent = "";
      const head = el("div", "gw-detail-head");
      const top = el("div", "gw-detail-head-top");
      const back = GW.el("button", "gw-back");
      back.type = "button";
      back.title = "返回列表";
      back.innerHTML = GW.icon("chevronLeft", 15);
      back.addEventListener("click", () => this.root.classList.remove("detail-open"));

      const subject = el("div", "gw-detail-subject", detail.subject || "(无提交信息)");
      top.append(back, subject);
      head.append(top);

      const authorRow = el("div", "gw-detail-author");
      authorRow.append(GW.avatar(detail.author, 22));
      const authorText = el("div", "gw-author-text");
      authorText.append(el("div", "gw-author-name", detail.author || "未知作者"));
      if (detail.email) authorText.append(el("div", "gw-author-email", detail.email));
      authorRow.append(authorText);
      if (detail.authoredAt) {
        const date = el("div", "gw-detail-date", GW.fmtDate(detail.authoredAt));
        date.title = detail.authoredAt;
        authorRow.append(date);
      }
      head.append(authorRow);

      const meta = el("div", "gw-detail-meta");
      const hashButton = el("button", "gw-hash", detail.short || String(detail.hash).slice(0, 7));
      hashButton.type = "button";
      hashButton.title = `${detail.hash}\n点击复制完整哈希`;
      hashButton.addEventListener("click", () => GW.copyWithToast(detail.hash, "提交哈希"));
      meta.append(hashButton);

      if (detail.parents && detail.parents.length) {
        const parents = el("span", null, "父提交");
        meta.append(parents);
        for (const parent of detail.parents) {
          const chip = el("button", "gw-parent", parent.slice(0, 7));
          chip.type = "button";
          chip.title = `查看 ${parent}`;
          chip.addEventListener("click", () => this.select(parent));
          meta.append(chip);
        }
      }
      head.append(meta);

      if (this.currentRefs && this.currentRefs.length) {
        const refs = el("div", "gw-detail-refs");
        for (const ref of this.currentRefs) {
          refs.append(el("span", `gw-ref ${ref.type}`, refLabel(ref)));
        }
        head.append(refs);
      }

      this.detail.scroll.append(head);

      if (detail.body) {
        this.detail.scroll.append(el("div", "gw-detail-body", detail.body));
      }

      if (detail.merge) {
        const note = el("div", "gw-merge-note");
        note.append(
          GW.iconEl("alert", 12),
          el("span", null, "合并提交，文件差异相对于第一父提交显示。")
        );
        this.detail.scroll.append(note);
      }

      const sectionHead = el("div", "gw-detail-section-head");
      sectionHead.append(el("span", null, `${detail.stats ? detail.stats.files : (detail.files || []).length} 个文件`));
      if (detail.stats) {
        if (detail.stats.additions) sectionHead.append(el("span", "gw-stat-add", `+${detail.stats.additions}`));
        if (detail.stats.deletions) sectionHead.append(el("span", "gw-stat-del", `−${detail.stats.deletions}`));
      }
      sectionHead.append(el("div", "gw-toolbar-spacer"));
      if (detail.truncated) sectionHead.append(el("span", "gw-count-pill", "仅显示前 800 个"));
      this.detail.scroll.append(sectionHead);

      if (!detail.files || detail.files.length === 0) {
        this.detail.scroll.append(el("div", "gw-detail-empty", "没有文件变更"));
        return;
      }

      for (const file of detail.files) {
        const row = el("div", "gw-file-row");
        row.dataset.path = file.path;
        row.append(el("span", `gw-badge gw-badge-${badgeClass(file.status)}`, file.status || "M"));
        const { dir, base } = splitPath(file.path);
        const pathBox = el("span", "gw-file-path");
        if (dir) pathBox.append(el("span", "gw-file-dir", dir));
        pathBox.append(el("span", "gw-file-base", base));
        if (file.origPath) pathBox.append(el("span", "gw-file-orig", `← ${file.origPath}`));
        row.append(pathBox);

        const stats = el("span", "gw-file-stats");
        if (file.binary) stats.append(el("span", null, "bin"));
        else {
          if (typeof file.additions === "number" && file.additions > 0) {
            stats.append(el("span", "gw-stat-add", `+${file.additions}`));
          }
          if (typeof file.deletions === "number" && file.deletions > 0) {
            stats.append(el("span", "gw-stat-del", `−${file.deletions}`));
          }
        }
        row.append(stats);
        row.title = file.path;
        row.addEventListener("click", () => this.openFileDiff(detail, file));
        this.detail.scroll.append(row);
      }
    }

    /* ------------------------------------------------------------------ */
    /* Commit file diff                                                   */
    /* ------------------------------------------------------------------ */

    async openFileDiff(detail, file) {
      this.fileKey = file.path;
      for (const row of this.detail.scroll.querySelectorAll(".gw-file-row")) {
        row.classList.toggle("selected", row.dataset.path === file.path);
      }
      this.diffDrawer.element.hidden = false;
      this.fileBadge.className = `gw-badge gw-badge-${badgeClass(file.status)}`;
      this.fileBadge.textContent = file.status || "M";
      this.fileTitle.textContent = file.path;
      this.fileTitle.title = file.path;
      this.fileInfo.textContent = "";
      this.fileLoadMore.hidden = true;
      this.diffDrawer.body.textContent = "";
      this.diffDrawer.body.append(el("div", "gw-diff-loading", "正在读取 diff…"));

      const cacheKey = `${detail.hash}:${file.path}`;
      const cached = this.diffCache.get(cacheKey);
      if (cached) {
        this.diffState = { ...cached };
        this.renderFileDiff();
        return;
      }
      await this.loadFileDiff({ reset: true, detail, file });
    }

    async loadFileDiff(options) {
      const reset = !options || options.reset !== false;
      const detail = this.currentDetail;
      if (!detail || !this.fileKey) return;
      const token = ++this.diffToken;
      const cursor = reset ? 0 : this.diffState && this.diffState.next != null ? this.diffState.next : 0;
      const file = (detail.files || []).find((item) => item.path === this.fileKey);
      if (!file) return;

      try {
        const result = await GW.call("git_commit_diff", {
          hash: detail.hash,
          path: file.path,
          ...(file.origPath ? { oldPath: file.origPath } : {}),
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
        this.diffCache.set(`${detail.hash}:${file.path}`, { ...this.diffState });
        this.renderFileDiff();
      } catch (error) {
        if (token !== this.diffToken) return;
        this.diffDrawer.body.textContent = "";
        this.diffDrawer.body.append(
          el("div", "gw-diff-loading", error.message || String(error))
        );
        this.fileInfo.textContent = "";
        this.fileLoadMore.hidden = true;
      }
    }

    renderFileDiff() {
      if (!this.diffState) return;
      this.diffDrawer.body.textContent = "";
      const stats = GW.renderDiff(this.diffDrawer.body, this.diffState.text, {
        binary: this.diffState.binary,
        empty: this.diffState.empty,
      });
      const blocks = this.diffDrawer.body.querySelectorAll(".gw-dblock");
      if (blocks.length === 1) {
        const header = blocks[0].querySelector(".gw-dfile");
        if (header) header.hidden = true;
      }
      const parts = [stats.binary ? "二进制文件" : `${this.diffState.totalLines || 0} 行`];
      if (stats.additions) parts.push(`+${stats.additions}`);
      if (stats.deletions) parts.push(`−${stats.deletions}`);
      this.fileInfo.textContent = parts.join(" · ");
      this.fileLoadMore.hidden = this.diffState.next == null;
      if (this.diffState.next != null) this.fileInfo.textContent += " · 已显示部分内容";
    }

    closeFileDiff() {
      this.diffToken += 1;
      this.fileKey = null;
      this.diffState = null;
      this.diffDrawer.element.hidden = true;
      this.diffDrawer.body.textContent = "";
      this.fileInfo.textContent = "";
      this.fileLoadMore.hidden = true;
      for (const row of this.detail.scroll.querySelectorAll(".gw-file-row")) {
        row.classList.remove("selected");
      }
    }

    clearDetail() {
      this.currentDetail = null;
      this.detail.scroll.textContent = "";
      this.detail.scroll.append(el("div", "gw-detail-empty", "选择一个提交查看详情"));
      this.closeFileDiff();
      this.root.classList.remove("detail-open");
    }

    handleEscape() {
      if (this.root.classList.contains("branches-open")) {
        this.root.classList.remove("branches-open");
        return true;
      }
      if (!this.diffDrawer.element.hidden) {
        this.closeFileDiff();
        return true;
      }
      if (this.root.classList.contains("detail-open")) {
        this.root.classList.remove("detail-open");
        return true;
      }
      if (this.query) {
        this.clearSearch();
        return true;
      }
      if (this.authorQuery) {
        this.authorInput.value = "";
        this.onAuthor();
        return true;
      }
      return false;
    }

    destroy() {
      this.diffCache.clear();
      this.detailCache.clear();
    }
  }

  GW.LogView = LogView;
})();
