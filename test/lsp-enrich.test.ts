/**
 * LSP enrichment tier: registry selection + graceful degradation. These run
 * without any language server installed — they assert the OPT-IN promise that
 * `graft build --lsp` is a safe no-op when no server applies (never a crash,
 * never a mutated graph), which is the contract the build relies on.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickServer, pickServers, LSP_SERVERS } from "../src/graph/lsp/registry.js";
import { enrichWithLsp } from "../src/graph/lsp/enrich.js";
import type { GraphV1 } from "../src/graph/types.js";

test("pickServer: no languages present → no server", () => {
  assert.equal(pickServer(new Set()), null);
});

test("pickServer: a language no registered server covers → null", () => {
  assert.equal(pickServer(new Set(["cobol", "fortran"])), null);
});

test("pickServers returns every applicable server, not just the first", () => {
  // Nothing installed for these, so both agree on the empty case regardless of
  // what this machine happens to have on PATH.
  assert.deepEqual(pickServers(new Set(["cobol"])), []);
  assert.equal(pickServer(new Set(["cobol"])), null);

  // Whatever this machine resolves, the single-pick answer must be the first of
  // the multi-pick answer — pickServer is now defined in terms of pickServers.
  const langs = new Set(LSP_SERVERS.flatMap((s) => s.languages));
  const all = pickServers(langs);
  // Each call spreads a fresh object, so compare by value, not identity.
  assert.deepEqual(pickServer(langs), all[0] ?? null);
  // Rows claim disjoint languages, so running all of them cannot double-count.
  const seen = new Set<string>();
  for (const s of all) {
    for (const l of s.languages) {
      assert.ok(!seen.has(l), `${l} claimed by more than one selected server`);
      seen.add(l);
    }
  }
});

test("registry rows are well-formed (languages, command, languageId)", () => {
  for (const s of LSP_SERVERS) {
    assert.ok(s.languages.length > 0 && s.command && s.languageId, `${s.command} row shape`);
    assert.ok(Array.isArray(s.args), `${s.command} args is an array`);
  }
});

test("enrichWithLsp is a no-op when no server matches the repo's languages", async () => {
  // A graph whose only file is an unsupported language → no server is picked →
  // no process spawned, graph returned unchanged.
  const graph: GraphV1 = {
    meta: { version: 1, nodeCount: 1, edgeCount: 0, languages: ["text"], scopes: [] },
    nodes: [
      { id: "notes.txt", name: "notes.txt", kind: "file", path: "notes.txt", span: "L1-L1",
        signature: null, exported: true, origin: "ast", body_hash: "x", summary_state: "pending", summary: null, crux: null },
    ],
    edges: [],
  };
  const before = graph.edges.length;
  const r = await enrichWithLsp(graph, "/tmp/does-not-matter");
  assert.equal(r.server, null, "no server selected for an unsupported language");
  assert.equal(r.added, 0);
  assert.equal(graph.edges.length, before, "graph edges untouched");
});
