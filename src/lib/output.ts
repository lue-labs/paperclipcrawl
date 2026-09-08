/** Tiny output helpers: JSON or fixed-width text tables, no color deps. */

export function printJson(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

export function truncate(s: string | null | undefined, n: number): string {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v.length > n ? `${v.slice(0, Math.max(0, n - 1))}…` : v;
}

export function table(rows: Array<Record<string, unknown>>, columns: Array<{ key: string; label: string; width?: number }>): string {
  if (rows.length === 0) return "(empty)\n";
  const widths = columns.map((c) => {
    const max = Math.max(c.label.length, ...rows.map((r) => String(r[c.key] ?? "").length));
    return c.width ? Math.min(c.width, max) : max;
  });
  const line = (cells: string[]) => cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join("  ").trimEnd();
  const out = [line(columns.map((c) => c.label)), line(widths.map((w) => "-".repeat(w)))];
  for (const r of rows) {
    out.push(line(columns.map((c, i) => truncate(String(r[c.key] ?? ""), widths[i] ?? 0))));
  }
  return `${out.join("\n")}\n`;
}

export function relTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "never";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Parse "5m", "2h", "90s", "1d" into ms. */
export function parseDuration(v: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)?$/.exec(v.trim());
  if (!m) throw new Error(`Invalid duration '${v}' (use e.g. 90s, 5m, 2h, 1d)`);
  const n = Number(m[1]);
  switch (m[2] ?? "s") {
    case "ms": return n;
    case "s": return n * 1000;
    case "m": return n * 60_000;
    case "h": return n * 3_600_000;
    case "d": return n * 86_400_000;
    default: return n * 1000;
  }
}

export function warn(msg: string): void {
  process.stderr.write(`${msg}\n`);
}
