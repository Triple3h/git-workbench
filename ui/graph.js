(function () {
  "use strict";

  const GW = (window.GW = window.GW || {});

  const COLORS = [
    "#4f8cff",
    "#a371f7",
    "#f0883e",
    "#3fb950",
    "#f85149",
    "#39c5cf",
    "#d29922",
    "#ec6cb9",
    "#7ee787",
    "#79c0ff",
  ];

  const colorFor = (lane) => COLORS[lane % COLORS.length];

  function curve(x1, y1, x2, y2, color) {
    const dy = y2 - y1;
    const c1y = y1 + dy * 0.45;
    const c2y = y2 - dy * 0.45;
    return `<path d="M ${x1} ${y1} C ${x1} ${c1y}, ${x2} ${c2y}, ${x2} ${y2}" stroke="${color}" stroke-width="1.8" fill="none" stroke-linecap="round"/>`;
  }

  /**
   * Assign each commit to a lane and render one SVG segment per row.
   * Commits must be in git's topo order (newest first).
   */
  GW.computeGraph = function (commits, options) {
    const rowHeight = (options && options.rowHeight) || 40;
    const laneWidth = (options && options.laneWidth) || 12;
    const maxLanes = (options && options.maxLanes) || 10;

    let lanes = [];
    const rows = [];
    let maxUsed = 1;

    const findLane = (hash) => lanes.indexOf(hash);
    const freeLane = () => {
      const index = lanes.indexOf(null);
      return index === -1 ? lanes.length : index;
    };
    const ensure = (index) => {
      while (lanes.length <= index) lanes.push(null);
    };

    for (const commit of commits) {
      let lane = findLane(commit.hash);
      if (lane === -1) {
        lane = freeLane();
        ensure(lane);
        lanes[lane] = commit.hash;
      }

      const before = lanes.slice();

      for (let j = 0; j < before.length; j += 1) {
        if (j !== lane && before[j] === commit.hash) lanes[j] = null;
      }
      lanes[lane] = null;

      const parents = Array.isArray(commit.parents) ? commit.parents.filter(Boolean) : [];
      for (let k = 0; k < parents.length; k += 1) {
        const parent = parents[k];
        let target = lanes.indexOf(parent);
        if (target === -1) {
          if (k === 0 && lanes[lane] === null) {
            target = lane;
          } else {
            target = freeLane();
            ensure(target);
          }
          lanes[target] = parent;
        }
      }

      const after = lanes.slice();
      while (after.length > 0 && after[after.length - 1] === null) after.pop();
      lanes.length = after.length;

      maxUsed = Math.max(maxUsed, before.length, after.length);
      rows.push({
        hash: commit.hash,
        lane,
        before,
        after,
        parentCount: parents.length,
      });
    }

    const laneCount = Math.max(1, Math.min(maxUsed, maxLanes));
    const width = 12 + laneCount * laneWidth;

    const xFor = (index) =>
      7 + (Math.min(index, laneCount - 1) + 0.5) * laneWidth;

    for (const row of rows) {
      const mid = rowHeight / 2;
      const parts = [];

      // Upper half: lines entering the row.
      for (let j = 0; j < row.before.length; j += 1) {
        const hash = row.before[j];
        if (!hash) continue;
        const x = xFor(j);
        if (j === row.lane) {
          parts.push(
            `<path d="M ${x} 0 L ${x} ${mid}" stroke="${colorFor(j)}" stroke-width="1.8" fill="none"/>`
          );
        } else if (hash === row.hash) {
          // Another lane converges into this commit.
          parts.push(curve(x, 0, xFor(row.lane), mid, colorFor(j)));
        } else {
          parts.push(
            `<path d="M ${x} 0 L ${x} ${rowHeight}" stroke="${colorFor(j)}" stroke-width="1.8" fill="none"/>`
          );
        }
      }

      // Lower half: lanes leaving the row.
      for (let j = 0; j < row.after.length; j += 1) {
        const hash = row.after[j];
        if (!hash) continue;
        const x = xFor(j);
        if (j === row.lane) {
          parts.push(
            `<path d="M ${x} ${mid} L ${x} ${rowHeight}" stroke="${colorFor(j)}" stroke-width="1.8" fill="none"/>`
          );
        } else if (row.after[j] !== row.before[j]) {
          // Parent edge branching to another lane (or a reused lane).
          parts.push(curve(xFor(row.lane), mid, x, rowHeight, colorFor(j)));
        }
      }

      const dotX = xFor(row.lane);
      const color = colorFor(row.lane);
      if (row.parentCount > 1) {
        parts.push(
          `<circle cx="${dotX}" cy="${mid}" r="3.4" fill="var(--gw-bg)" stroke="${color}" stroke-width="2"/>`
        );
      } else {
        parts.push(`<circle cx="${dotX}" cy="${mid}" r="3.5" fill="${color}"/>`);
      }

      row.svg = `<svg width="${width}" height="${rowHeight}" viewBox="0 0 ${width} ${rowHeight}" aria-hidden="true">${parts.join("")}</svg>`;
      row.width = width;
    }

    return { rows, width, laneCount, laneWidth, rowHeight };
  };
})();
