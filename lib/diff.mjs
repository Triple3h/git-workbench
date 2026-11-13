export const DIFF_BUDGET_BYTES = 24 * 1024;

/**
 * Paginate a unified diff by lines, keeping each page under the byte budget.
 * `cursor` is a line index returned as `next` from the previous page.
 */
export function paginate(text, cursor = 0, budget = DIFF_BUDGET_BYTES) {
  const lines = String(text ?? "").split("\n");
  const start = Math.max(0, Number.isFinite(cursor) ? Math.trunc(cursor) : 0);
  const out = [];
  let used = 0;
  let index = start;

  for (; index < lines.length; index += 1) {
    const line = lines[index];
    const size = Buffer.byteLength(line, "utf8") + 1;
    if (out.length > 0 && used + size > budget) break;
    if (out.length === 0 && size > budget) {
      const cut = Buffer.from(line, "utf8").subarray(0, Math.max(0, budget - 24)).toString("utf8");
      out.push(`${cut} … [此行过长，已截断]`);
      index += 1;
      break;
    }
    out.push(line);
    used += size;
  }

  return {
    text: out.join("\n"),
    next: index < lines.length ? index : null,
    totalLines: lines.length,
  };
}

const BINARY_RE = /^Binary files .+ differ$/m;

export function looksBinary(text) {
  return BINARY_RE.test(String(text ?? ""));
}

/** Trim noise the panel never shows and normalize untracked diffs. */
export function normalizeDiff(text) {
  return String(text ?? "")
    .replace(/^diff --git a\/dev\/null b\/(.+)$/gm, "diff --git /dev/null b/$1")
    .replace(/^diff --git a\/(.+) b\/dev\/null$/gm, "diff --git a/$1 /dev/null")
    .replace(/\r\n/g, "\n");
}

export function diffStats(text) {
  let additions = 0;
  let deletions = 0;
  for (const line of String(text ?? "").split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions += 1;
    else if (line.startsWith("-")) deletions += 1;
  }
  return { additions, deletions };
}
