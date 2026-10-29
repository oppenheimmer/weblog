// Bounded, text-only comparison shared by history and publication review.
export function fieldChanges(before = {}, after = {}) {
  return ["title", "date", "format", "slug", "description", "tags"].flatMap((name) => {
    const oldValue = before[name] ?? (name === "tags" ? [] : "");
    const newValue = after[name] ?? (name === "tags" ? [] : "");
    return JSON.stringify(oldValue) === JSON.stringify(newValue) ? [] : [{ name, before: oldValue, after: newValue }];
  });
}

export function assetChanges(before = {}, after = {}) {
  const changes = [];
  for (const [field, label, identity] of [
    ["media", "Image", (a) => a.publicName],
    ["interactives", "Interactive", (a) => `${a.kind} ${a.name}`],
  ]) {
    const oldItems = new Map((before[field] ?? []).map((a) => [identity(a), a]));
    const newItems = new Map((after[field] ?? []).map((a) => [identity(a), a]));
    for (const name of new Set([...oldItems.keys(), ...newItems.keys()])) {
      const oldItem = oldItems.get(name), newItem = newItems.get(name);
      if (!oldItem) changes.push(`${label} added: ${name}`);
      else if (!newItem) changes.push(`${label} removed: ${name}`);
      else if ((oldItem.sha256 ?? oldItem.revisionId) !== (newItem.sha256 ?? newItem.revisionId)) {
        changes.push(`${label} changed: ${name}${newItem.revisionId ? ` · ${oldItem.revisionId} → ${newItem.revisionId}` : ""}`);
      }
    }
  }
  return changes;
}

export function diffLines(before = "", after = "") {
  const a = before.split("\n"), b = after.split("\n");
  let start = 0, endA = a.length, endB = b.length;
  while (start < endA && start < endB && a[start] === b[start]) start++;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
  const rows = [];
  let shortened = false;
  const emit = (kind, text) => {
    if (rows.length >= 1000) { shortened = true; return; }
    if (text.length > 4000) shortened = true;
    rows.push({ kind, text: text.slice(0, 4000) });
  };
  const oldLines = a.slice(start, endA), newLines = b.slice(start, endB);
  if (oldLines.length * newLines.length <= 200_000) {
    const width = newLines.length + 1;
    const table = new Uint32Array((oldLines.length + 1) * width);
    for (let i = oldLines.length - 1; i >= 0; i--) {
      for (let j = newLines.length - 1; j >= 0; j--) {
        table[i * width + j] = oldLines[i] === newLines[j]
          ? 1 + table[(i + 1) * width + j + 1]
          : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < oldLines.length || j < newLines.length) {
      if (i < oldLines.length && j < newLines.length && oldLines[i] === newLines[j]) {
        emit("same", oldLines[i++]); j++;
      } else if (i < oldLines.length && (j === newLines.length || table[(i + 1) * width + j] >= table[i * width + j + 1])) {
        emit("removed", oldLines[i++]);
      } else emit("added", newLines[j++]);
    }
  } else {
    for (const line of oldLines) emit("removed", line);
    for (const line of newLines) emit("added", line);
  }
  return { rows, shortened, changed: before !== after };
}
