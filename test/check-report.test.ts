/**
 * The STALE report is read to decide whether to rebuild. The counts answer that;
 * the listed ids only have to make the drift recognizable. Listing every id
 * scaled the report with the repo rather than with the drift — a first check of
 * a 161k-node repo produced 137,477 lines and 12.7 MB, well past what a terminal
 * or an MCP tool-output budget can carry.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatGraphCheckReport } from "../src/graph/check.js";
import type { GraphCheckResult } from "../src/graph/check.js";

const result = (over: Partial<GraphCheckResult>): GraphCheckResult => ({
  ok: false,
  missing: false,
  added: [],
  removed: [],
  changed: [],
  stale: [],
  pending: 0,
  ...over,
});

const ids = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => `src/${prefix}${i}.ts#fn`);

test("a large drift is capped, and says how much it withheld", () => {
  const report = formatGraphCheckReport(result({ added: ids("a", 5000) }));

  // The full count still leads the section — that is what the reader acts on.
  assert.match(report, /^added \(5000\):$/m);
  const listed = report.split("\n").filter((l) => l.startsWith("  + "));
  assert.equal(listed.length, 50);
  assert.match(report, /… and 4950 more/);
  // A bounded report, not one that scales with the repo.
  assert.ok(report.length < 8000, `report was ${report.length} chars`);
});

test("a small drift is listed in full, with no withheld line", () => {
  const report = formatGraphCheckReport(result({ changed: ids("c", 3), removed: ids("r", 2) }));

  assert.equal(report.split("\n").filter((l) => l.startsWith("  ~ ")).length, 3);
  assert.equal(report.split("\n").filter((l) => l.startsWith("  - ")).length, 2);
  assert.ok(!report.includes("and 0 more"), "no withheld line when nothing was withheld");
  assert.ok(!report.includes("…"), "no ellipsis when nothing was withheld");
});

test("each section is capped independently", () => {
  const report = formatGraphCheckReport(result({ added: ids("a", 80), changed: ids("c", 80), stale: ids("s", 80) }));

  assert.equal(report.split("\n").filter((l) => l.startsWith("  + ")).length, 50);
  assert.equal(report.split("\n").filter((l) => l.startsWith("  ~ ")).length, 50);
  assert.equal(report.split("\n").filter((l) => l.startsWith("  ! ")).length, 50);
  assert.equal(report.split("\n").filter((l) => l.includes("and 30 more")).length, 3);
});

test("a clean or missing graph is unchanged", () => {
  assert.match(formatGraphCheckReport(result({ ok: true })), /^graph check: OK/);
  assert.match(formatGraphCheckReport(result({ missing: true })), /^graph check: NO GRAPH/);
});
