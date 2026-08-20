import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ask } from "../src/ask/ask.js";
import { buildGraph } from "../src/graph/build.js";

/**
 * A summary is the only place a symbol's PURPOSE is written in the words someone
 * searching would use — the identifier rarely says it. Scoring summaries only
 * inside `body`, where BM25 length normalization dilutes them, made such a node
 * effectively unfindable; this pins that it is retrievable by purpose alone.
 */
test("a symbol is retrievable by what its summary says it does", async () => {
  const dir = mkdtempSync(join(tmpdir(), "graft-ask-summary-"));
  const prevRefresh = process.env.GRAFT_NO_REFRESH;
  process.env.GRAFT_NO_REFRESH = "1"; // a refresh would rebuild over the injected summaries
  try {
    writeFileSync(
      join(dir, "a.ts"),
      // Deliberately opaque names: nothing here shares a word with the query.
      `export function qz7(a: string, b: string): boolean {\n  return a === b;\n}\n` +
        Array.from({ length: 15 }, (_, i) =>
          `export function helper${i}(v: number): string {\n  return String(v);\n}\n`).join(""),
    );
    await buildGraph(dir);

    const graphPath = join(dir, "graft", ".graph", "wiring.json");
    const graph = JSON.parse(readFileSync(graphPath, "utf8")) as {
      nodes: { name: string; summary?: string | null; summary_state?: string }[];
    };
    for (const n of graph.nodes) {
      n.summary =
        n.name === "qz7"
          ? "Rejects an upload whose declared checksum disagrees with the stored bytes."
          : "Formats a value for display.";
      n.summary_state = "ready";
    }
    writeFileSync(graphPath, JSON.stringify(graph));

    const res = ask(dir, "where do we reject an upload whose checksum disagrees");
    const pointers = res.hits.map((h) => String(h.pointer ?? "")).join(" ");
    const titles = res.hits.map((h) => String(h.title ?? "")).join(" ");
    assert.ok(
      /qz7/.test(titles) || /qz7/.test(pointers),
      `summary-only match must be retrievable; got: ${titles}`,
    );
  } finally {
    if (prevRefresh === undefined) delete process.env.GRAFT_NO_REFRESH;
    else process.env.GRAFT_NO_REFRESH = prevRefresh;
    rmSync(dir, { recursive: true, force: true });
  }
});
