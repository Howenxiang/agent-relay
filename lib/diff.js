// 零依赖行级文本 Diff 引擎（LCS + 统一 Diff Hunk 生成，带大文件保护）

function splitLines(text) {
  const s = String(text ?? '').replace(/\r\n/g, '\n');
  if (!s) return [];
  return s.split('\n');
}

function lcsDiffOps(a, b) {
  // 先裁剪公共前缀与公共后缀，显著减小 DP 规模
  let start = 0;
  const minLen = Math.min(a.length, b.length);
  while (start < minLen && a[start] === b[start]) start++;

  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }

  const ops = [];
  for (let i = 0; i < start; i++) ops.push({ type: 'equal', text: a[i], oldLine: i + 1, newLine: i + 1 });

  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const m = midA.length;
  const n = midB.length;

  if (m === 0 && n === 0) {
    // identical
  } else if (m * n > 2_000_000) {
    // 超大文件降级为块替换，防止内存暴涨
    for (let i = 0; i < m; i++) ops.push({ type: 'remove', text: midA[i], oldLine: start + i + 1, newLine: null });
    for (let j = 0; j < n; j++) ops.push({ type: 'add', text: midB[j], oldLine: null, newLine: start + j + 1 });
  } else {
    const dp = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
    for (let i = m - 1; i >= 0; i--) {
      const row = dp[i];
      const next = dp[i + 1];
      const lineA = midA[i];
      for (let j = n - 1; j >= 0; j--) {
        row[j] = lineA === midB[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (midA[i] === midB[j]) {
        ops.push({ type: 'equal', text: midA[i], oldLine: start + i + 1, newLine: start + j + 1 });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: 'remove', text: midA[i], oldLine: start + i + 1, newLine: null });
        i++;
      } else {
        ops.push({ type: 'add', text: midB[j], oldLine: null, newLine: start + j + 1 });
        j++;
      }
    }
    while (i < m) {
      ops.push({ type: 'remove', text: midA[i], oldLine: start + i + 1, newLine: null });
      i++;
    }
    while (j < n) {
      ops.push({ type: 'add', text: midB[j], oldLine: null, newLine: start + j + 1 });
      j++;
    }
  }

  for (let k = 0; k < a.length - endA; k++) {
    ops.push({ type: 'equal', text: a[endA + k], oldLine: endA + k + 1, newLine: endB + k + 1 });
  }
  return ops;
}

function buildHunks(ops, context = 3) {
  const changeIndices = [];
  for (let i = 0; i < ops.length; i++) {
    if (ops[i].type !== 'equal') changeIndices.push(i);
  }
  if (!changeIndices.length) return [];

  const ranges = [];
  for (const idx of changeIndices) {
    const lo = Math.max(0, idx - context);
    const hi = Math.min(ops.length - 1, idx + context);
    if (ranges.length && lo <= ranges[ranges.length - 1][1] + 1) {
      ranges[ranges.length - 1][1] = Math.max(ranges[ranges.length - 1][1], hi);
    } else {
      ranges.push([lo, hi]);
    }
  }

  return ranges.map(([lo, hi]) => {
    const lines = ops.slice(lo, hi + 1);
    const oldLines = lines.filter(l => l.oldLine !== null);
    const newLines = lines.filter(l => l.newLine !== null);
    const oldStart = oldLines.length ? oldLines[0].oldLine : 0;
    const newStart = newLines.length ? newLines[0].newLine : 0;
    const oldCount = oldLines.length;
    const newCount = newLines.length;
    return {
      header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
      oldStart,
      oldCount,
      newStart,
      newCount,
      lines,
    };
  });
}

function diffText(oldText, newText, { fromLabel = 'before', toLabel = 'after', context = 3 } = {}) {
  const oldArr = splitLines(oldText);
  const newArr = splitLines(newText);
  const ops = lcsDiffOps(oldArr, newArr);
  let added = 0;
  let removed = 0;
  let unchanged = 0;
  for (const op of ops) {
    if (op.type === 'add') added++;
    else if (op.type === 'remove') removed++;
    else unchanged++;
  }
  const hunks = buildHunks(ops, context);
  const unifiedLines = [`--- ${fromLabel}`, `+++ ${toLabel}`];
  for (const h of hunks) {
    unifiedLines.push(h.header);
    for (const l of h.lines) {
      const prefix = l.type === 'add' ? '+' : l.type === 'remove' ? '-' : ' ';
      unifiedLines.push(`${prefix}${l.text}`);
    }
  }
  return {
    identical: added === 0 && removed === 0,
    stats: { added, removed, unchanged },
    hunks,
    unified: hunks.length ? `${unifiedLines.join('\n')}\n` : '',
  };
}

module.exports = { diffText };
