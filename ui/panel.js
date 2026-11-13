(function () {
  "use strict";

  const GW = (window.GW = window.GW || {});
  GW.z = window.zcode || null;

  /* ---------------------------------------------------------------------- */
  /* Icons                                                                  */
  /* ---------------------------------------------------------------------- */

  const ICONS = {
    refresh: '<path d="M21 12a9 9 0 1 1-3.2-6.9"/><path d="M21 3v6h-6"/>',
    copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    chevronLeft: '<path d="m15 18-6-6 6-6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    branch:
      '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    commit: '<circle cx="12" cy="12" r="4"/><path d="M2 12h6M16 12h6"/>',
    file: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>',
    folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    eye: '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
    alert: '<path d="M12 9v4M12 17h.01"/><path d="M10.3 3.9 2.4 18a2 2 0 0 0 1.7 3h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
    tag: '<path d="M20.6 13.4 12 22l-9-9V3h10l7.6 7.6a2 2 0 0 1 0 2.8Z"/><circle cx="7.5" cy="7.5" r="1.5"/>',
    arrowUp: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    arrowDown: '<path d="M12 5v14M19 12l-7 7-7-7"/>',
    list: '<path d="M8 6h13M8 12h13M8 18h13"/><path d="M3 6h.01M3 12h.01M3 18h.01"/>',
    user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
    history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l3 2"/>',
    dot: '<circle cx="12" cy="12" r="3" fill="currentColor" stroke="none"/>',
  };

  GW.icon = function (name, size) {
    const body = ICONS[name] || ICONS.dot;
    const px = size || 16;
    return `<svg width="${px}" height="${px}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  };

  /* ---------------------------------------------------------------------- */
  /* DOM helpers                                                            */
  /* ---------------------------------------------------------------------- */

  GW.el = function (tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text !== undefined && text !== null) element.textContent = text;
    return element;
  };

  GW.iconEl = function (name, size, className) {
    const span = GW.el("span", className || "gw-icon");
    span.innerHTML = GW.icon(name, size);
    return span;
  };

  GW.iconButton = function (name, title, onClick, size) {
    const button = GW.el("button", "gw-icon-btn");
    button.type = "button";
    button.title = title;
    button.setAttribute("aria-label", title);
    button.innerHTML = GW.icon(name, size || 16);
    if (onClick) button.addEventListener("click", onClick);
    return button;
  };

  /* ---------------------------------------------------------------------- */
  /* Avatars                                                                */
  /* ---------------------------------------------------------------------- */

  const AVATAR_HUES = [214, 262, 168, 26, 340, 190];

  GW.initials = function (name) {
    const text = String(name || "").trim();
    if (!text) return "?";
    if (/[\u3400-\u9fff]/.test(text)) return text.slice(-1);
    const parts = text.split(/[\s._-]+/).filter(Boolean);
    if (parts.length > 1) {
      return (parts[0].charAt(0) + parts[parts.length - 1].charAt(0)).toUpperCase();
    }
    return text.slice(0, 2).toUpperCase();
  };

  GW.avatar = function (name, size) {
    const text = String(name || "").trim();
    let hash = 0;
    for (let index = 0; index < text.length; index += 1) {
      hash = (hash * 31 + text.charCodeAt(index)) % 360;
    }
    const node = GW.el(
      "span",
      `gw-avatar${size && size > 20 ? " gw-avatar-lg" : ""}`,
      GW.initials(text)
    );
    node.style.setProperty("--gw-h", String(AVATAR_HUES[hash % AVATAR_HUES.length]));
    node.title = text;
    node.setAttribute("aria-hidden", "true");
    return node;
  };

  GW.debounce = function (fn, wait) {
    let timer = null;
    return function debounced(...args) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        fn.apply(this, args);
      }, wait);
    };
  };

  /* ---------------------------------------------------------------------- */
  /* Host bridge                                                            */
  /* ---------------------------------------------------------------------- */

  GW.call = async function (name, args) {
    const z = GW.z;
    if (!z || typeof z.callTool !== "function") {
      throw new Error("宿主桥接不可用，无法调用 Git 工具");
    }
    const result = await z.callTool(name, args || {});
    const text = (result && Array.isArray(result.content) ? result.content : [])
      .filter((block) => block && block.type === "text" && typeof block.text === "string")
      .map((block) => block.text)
      .join("\n");
    const structured = result && result.structuredContent;
    if (result && result.isError) {
      const error = new Error(
        (structured && structured.error && structured.error.message) || text || `${name} 调用失败`
      );
      error.code = (structured && structured.error && structured.error.code) || "tool_error";
      throw error;
    }
    if (structured && structured.error) {
      const error = new Error(structured.error.message || `${name} 调用失败`);
      error.code = structured.error.code || "tool_error";
      throw error;
    }
    return { text, structured };
  };

  /* ---------------------------------------------------------------------- */
  /* Theme                                                                  */
  /* ---------------------------------------------------------------------- */

  GW.applyHostContext = function () {
    const z = GW.z;
    const context = z && z.hostContext;
    if (!context) return;
    const theme = context.theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    const variables = context.styles && context.styles.variables;
    if (variables) {
      for (const [name, value] of Object.entries(variables)) {
        if (value) document.documentElement.style.setProperty(name, value);
      }
    }
    const fonts = context.styles && context.styles.css && context.styles.css.fonts;
    if (fonts) {
      let style = document.getElementById("gw-host-fonts");
      if (!style) {
        style = document.createElement("style");
        style.id = "gw-host-fonts";
        document.head.append(style);
      }
      style.textContent = fonts;
    }
  };

  /* ---------------------------------------------------------------------- */
  /* Formatting                                                             */
  /* ---------------------------------------------------------------------- */

  GW.isEnglish = function () {
    const locale = (GW.z && GW.z.locale) || "zh-CN";
    return String(locale).toLowerCase().startsWith("en");
  };

  GW.fmtDate = function (iso, options) {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return "";
    const english = GW.isEnglish();
    const format = new Intl.DateTimeFormat(english ? "en-US" : "zh-CN", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(options && options.dateOnly ? {} : { hour: "2-digit", minute: "2-digit" }),
    });
    return format.format(date);
  };

  GW.fmtRel = function (iso) {
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return "";
    const english = GW.isEnglish();
    const diff = Date.now() - time;
    const minute = 60_000;
    const hour = 60 * minute;
    const day = 24 * hour;
    if (diff < 0) return GW.fmtDate(iso);
    if (diff < minute) return english ? "just now" : "刚刚";
    if (diff < hour) {
      const value = Math.floor(diff / minute);
      return english ? `${value}m ago` : `${value} 分钟前`;
    }
    if (diff < day) {
      const value = Math.floor(diff / hour);
      return english ? `${value}h ago` : `${value} 小时前`;
    }
    if (diff < 7 * day) {
      const value = Math.floor(diff / day);
      return english ? `${value}d ago` : `${value} 天前`;
    }
    return GW.fmtDate(iso, { dateOnly: true });
  };

  /* ---------------------------------------------------------------------- */
  /* Clipboard                                                              */
  /* ---------------------------------------------------------------------- */

  GW.copy = async function (text) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      const area = document.createElement("textarea");
      area.value = text;
      area.style.position = "fixed";
      area.style.opacity = "0";
      document.body.append(area);
      area.select();
      let ok = false;
      try {
        ok = document.execCommand("copy");
      } catch {
        ok = false;
      }
      area.remove();
      return ok;
    }
  };

  GW.copyWithToast = async function (text, label) {
    const ok = await GW.copy(text);
    GW.toast(ok ? `${label || "路径"}已复制` : "复制失败", ok ? "info" : "error");
  };

  /* ---------------------------------------------------------------------- */
  /* Toast                                                                  */
  /* ---------------------------------------------------------------------- */

  let toastTimer = null;

  GW.toast = function (message, kind) {
    const host = document.querySelector(".gw");
    if (!host) return;
    const existing = host.querySelector(".gw-toast");
    if (existing) existing.remove();
    if (toastTimer) clearTimeout(toastTimer);
    const toast = GW.el("div", `gw-toast${kind === "error" ? " error" : ""}`, message);
    host.append(toast);
    toastTimer = setTimeout(() => {
      toast.remove();
      toastTimer = null;
    }, 3600);
  };

  /* ---------------------------------------------------------------------- */
  /* Status bar                                                             */
  /* ---------------------------------------------------------------------- */

  function drawStatus(bar, data, updatedAt) {
    bar.textContent = "";
    const chip = GW.el("span", "gw-chip", "只读");
    bar.append(chip);

    if (!data) {
      bar.append(GW.el("span", "gw-status-item", "Git 工作台"));
      return;
    }

    if (data.isRepo === false) {
      const item = GW.el("span", "gw-status-item");
      item.append(GW.iconEl("alert", 12));
      item.append(GW.el("span", null, "非 Git 仓库"));
      bar.append(item);
      bar.append(GW.el("span", "gw-status-spacer"));
      const root = GW.el("button", "gw-status-root", data.workspace || "");
      root.type = "button";
      root.title = data.workspace || "";
      root.addEventListener("click", () => GW.copyWithToast(data.workspace, "路径"));
      bar.append(root);
      return;
    }

    const label = data.unborn
      ? "尚无提交"
      : data.detached
        ? "HEAD（游离）"
        : data.branch || "未知分支";
    const branchItem = GW.el("span", "gw-status-item");
    branchItem.append(GW.iconEl("branch", 12));
    branchItem.append(GW.el("span", null, label));
    bar.append(branchItem);

    if (data.ahead > 0) bar.append(GW.el("span", "gw-ahead", `↑${data.ahead}`));
    if (data.behind > 0) bar.append(GW.el("span", "gw-behind", `↓${data.behind}`));

    bar.append(GW.el("span", "gw-status-spacer"));

    if (data.root) {
      const root = GW.el("button", "gw-status-root", data.root);
      root.type = "button";
      root.title = data.root;
      root.addEventListener("click", () => GW.copyWithToast(data.root, "仓库路径"));
      bar.append(root);
    }

    if (updatedAt) {
      const time = new Date(updatedAt);
      const stamp = `${String(time.getHours()).padStart(2, "0")}:${String(time.getMinutes()).padStart(2, "0")}`;
      bar.append(GW.el("span", "gw-status-item", stamp));
    }
  }

  /* ---------------------------------------------------------------------- */
  /* App shell                                                              */
  /* ---------------------------------------------------------------------- */

  GW.start = async function () {
    GW.applyHostContext();
    if (GW.z && typeof GW.z.subscribe === "function") {
      GW.z.subscribe(() => GW.applyHostContext());
    }

    const root = document.getElementById("root");
    if (!root) throw new Error("页面缺少 #root 容器");

    const app = GW.el("div", "gw");

    const tabs = GW.el("header", "gw-tabs");
    const changesTab = GW.el("button", "gw-tab active");
    changesTab.type = "button";
    changesTab.append(GW.el("span", null, "变更"));
    const changesCount = GW.el("span", "gw-tab-count", "0");
    changesCount.hidden = true;
    changesTab.append(changesCount);

    const logTab = GW.el("button", "gw-tab");
    logTab.type = "button";
    logTab.textContent = "记录";

    const tabsSpacer = GW.el("div", "gw-tabs-spacer");
    const refreshButton = GW.iconButton("refresh", "刷新（⌘R）");
    tabs.append(changesTab, logTab, tabsSpacer, refreshButton);

    const body = GW.el("main", "gw-body");
    const statusBar = GW.el("footer", "gw-status");
    app.append(tabs, body, statusBar);

    root.textContent = "";
    root.append(app);

    const state = { active: "changes", status: null, updatedAt: 0 };

    function renderStatus(data) {
      state.status = data;
      state.updatedAt = Date.now();
      drawStatus(statusBar, data, state.updatedAt);
      const total = data && data.isRepo
        ? (data.counts.staged || 0) + (data.counts.unstaged || 0) + (data.counts.untracked || 0) +
          (data.counts.conflicted || 0)
        : 0;
      changesCount.textContent = total > 99 ? "99+" : String(total);
      changesCount.hidden = total === 0;
    }

    const changes = new GW.ChangesView({ onStatus: renderStatus });
    const log = new GW.LogView({ onStatus: renderStatus, getStatus: () => state.status });
    changes.element.hidden = false;
    log.element.hidden = true;
    body.append(changes.element, log.element);

    function switchTab(next, options) {
      if (state.active === next && !(options && options.force)) return;
      state.active = next;
      changesTab.classList.toggle("active", next === "changes");
      logTab.classList.toggle("active", next === "log");
      changes.element.hidden = next !== "changes";
      log.element.hidden = next !== "log";
      if (next === "log") {
        log.activate().catch((error) => GW.toast(error.message, "error"));
      } else {
        changes.refresh({ silent: true }).catch(() => {});
      }
    }

    async function refreshActive() {
      refreshButton.classList.add("spinning");
      refreshButton.disabled = true;
      try {
        if (state.active === "changes") await changes.refresh({ silent: false });
        else await log.activate({ force: true });
      } catch (error) {
        GW.toast(error.message || "刷新失败", "error");
      } finally {
        refreshButton.disabled = false;
        setTimeout(() => refreshButton.classList.remove("spinning"), 350);
      }
    }

    changesTab.addEventListener("click", () => switchTab("changes"));
    logTab.addEventListener("click", () => switchTab("log"));
    refreshButton.addEventListener("click", refreshActive);

    document.addEventListener("keydown", (event) => {
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "r") {
        event.preventDefault();
        refreshActive();
        return;
      }
      if (meta && (event.key === "1" || event.key === "2")) {
        event.preventDefault();
        switchTab(event.key === "1" ? "changes" : "log");
        return;
      }
      if (event.key === "Escape") {
        const handled = state.active === "changes" ? changes.handleEscape() : log.handleEscape();
        if (handled) event.preventDefault();
      }
    });

    window.addEventListener("beforeunload", () => {
      try {
        changes.destroy();
        log.destroy();
      } catch {
        /* ignore */
      }
    });

    await changes.activate();

    setInterval(() => {
      if (document.visibilityState === "hidden") return;
      changes.refresh({ silent: true }).catch(() => {});
    }, 3000);

    setInterval(() => {
      if (document.visibilityState === "hidden") return;
      drawStatus(statusBar, state.status, state.updatedAt);
    }, 60_000);

    return { switchTab, refreshActive, changes, log };
  };
})();
