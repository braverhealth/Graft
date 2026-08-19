/**
 * Opt-in LSP enrichment (`graft build --lsp`): add compiler-grade call edges the
 * AST resolver couldn't — chiefly member calls (`obj.foo()`) whose receiver type
 * graft can't infer, and every call in the generic breadth tier (which has no
 * receiver typing at all). For each function/method node we ask the language
 * server for its outgoing calls (call hierarchy) and map each callee's definition
 * back to a graft node, adding a `calls` edge stamped `lsp_resolved`. Precision is
 * the server's (compiler-grade), so this closes the edge-recall gap WITHOUT the
 * name-guessing that halved precision (see resolve.ts). Best-effort: no server /
 * a timeout / an error → the graph is returned unchanged.
 */
import { join } from "node:path";
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { relPosix } from "../../util/paths.js";
import { languageLabelOf } from "../extract.js";
import { genericLangOf } from "../generic.js";
import type { GraphV1, NodeV1, EdgeV1 } from "../types.js";
import { LspClient, type CallHierarchyItem } from "./client.js";
import { pickServers, type LspServer } from "./registry.js";

const CALLABLE = new Set<NodeV1["kind"]>(["function", "method"]);
const DEFN = new Set<NodeV1["kind"]>(["function", "method", "class", "struct", "interface", "type", "enum"]);

const langOf = (path: string): string | null => genericLangOf(path)?.name ?? languageLabelOf(path);

interface Span { node: NodeV1; from: number; to: number }
const parseSpan = (s: string): [number, number] | null => {
  const m = /^L(\d+)-L(\d+)$/.exec(s);
  return m ? [Number(m[1]), Number(m[2])] : null;
};

export interface EnrichOpts {
  onProgress?: (done: number, total: number) => void;
  maxNodes?: number;
  /** Restrict the pass to definitions in these files. Absent means every file,
   * which is what a cold build wants; an incremental build passes the files it
   * re-parsed and replays the rest from the edge memo. */
  onlyFiles?: Set<string>;
}

export interface LspEnrichResult {
  added: number;
  queried: number;
  server: string | null;
  /** The edges this pass added, so a caller can memo them per source file. */
  addedEdges: EdgeV1[];
  /** Every source file this pass covered, including the ones that yielded no
   * edge — the memo must record "asked, found nothing" or the next build asks
   * again forever. */
  queriedFiles: Set<string>;
}

export async function enrichWithLsp(
  graph: GraphV1,
  root: string,
  opts: EnrichOpts = {},
): Promise<LspEnrichResult> {
  const languagesPresent = new Set<string>();
  for (const n of graph.nodes) { const l = langOf(n.path); if (l) languagesPresent.add(l); }
  const servers = pickServers(languagesPresent);
  const nothing = { added: 0, queried: 0, addedEdges: [] as EdgeV1[], queriedFiles: new Set<string>() };
  if (!servers.length) return { ...nothing, server: null };

  let added = 0, queried = 0;
  const addedEdges: EdgeV1[] = [];
  const queriedFiles = new Set<string>();
  const used: string[] = [];
  for (const server of servers) {
    // One server's failure must not cost the others their edges, nor abort the
    // build: this tier is opt-in enrichment on top of a graph that already
    // stands on its own. A server that dies mid-request rejects from inside the
    // JSON-RPC writer, which is why this catch has to wrap the whole pass and
    // not just the spawn.
    try {
      const r = await enrichWithServer(graph, root, server, opts);
      added += r.added;
      queried += r.queried;
      addedEdges.push(...r.addedEdges);
      for (const f of r.queriedFiles) queriedFiles.add(f);
      if (r.queried > 0) used.push(server.command);
    } catch { /* leave the graph as the AST tier built it */ }
  }
  return { added, queried, server: used.join(", ") || servers[0].command, addedEdges, queriedFiles };
}

async function enrichWithServer(
  graph: GraphV1,
  root: string,
  server: LspServer,
  opts: EnrichOpts,
): Promise<LspEnrichResult> {

  // Canonicalize the root: servers (rust-analyzer/clangd) report callee URIs
  // against the REAL path, so under a symlinked checkout (macOS /tmp →
  // /private/tmp, common in CI) an un-resolved root would fail the in-repo test
  // for every callee and silently zero out enrichment.
  const realRoot = (() => { try { return realpathSync(root); } catch { return root; } })();
  root = realRoot;

  // Index nodes by file for both source selection and callee→node mapping.
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const spansByFile = new Map<string, Span[]>();
  for (const n of graph.nodes) {
    if (n.kind === "file" || !DEFN.has(n.kind)) continue;
    const sp = parseSpan(n.span); if (!sp) continue;
    const list = spansByFile.get(n.path) ?? [];
    list.push({ node: n, from: sp[0], to: sp[1] });
    spansByFile.set(n.path, list);
  }
  // The definition node covering a 1-indexed line in a file: innermost (smallest span).
  const nodeAt = (rel: string, line: number): NodeV1 | null => {
    const cands = (spansByFile.get(rel) ?? []).filter((s) => s.from <= line && line <= s.to);
    if (!cands.length) return null;
    return cands.sort((a, b) => (a.to - a.from) - (b.to - b.from))[0].node;
  };

  // Source nodes to query: callable nodes in files this server handles.
  const serverLangs = new Set(server.languages);
  let sources = graph.nodes.filter(
    (n) =>
      CALLABLE.has(n.kind) &&
      serverLangs.has(langOf(n.path) ?? "") &&
      (!opts.onlyFiles || opts.onlyFiles.has(n.path)),
  );
  if (opts.maxNodes && sources.length > opts.maxNodes) sources = sources.slice(0, opts.maxNodes);
  const queriedFiles = new Set(sources.map((n) => n.path));
  const addedEdges: EdgeV1[] = [];
  // Nothing to ask about — skip spawning the server at all. This is the common
  // case for an incremental build that touched no file this server handles, and
  // it is what keeps a one-file edit from paying a server startup per language.
  if (!sources.length) {
    return { added: 0, queried: 0, server: server.command, addedEdges, queriedFiles };
  }

  const client = new LspClient(server.command, server.args, root, server.languageId);
  if (!(await client.initialize())) {
    await client.dispose();
    return { added: 0, queried: 0, server: server.command, addedEdges, queriedFiles: new Set() };
  }

  const existing = new Set(graph.edges.map((e) => `${e.source}\0${e.relation}\0${e.target}`));
  const fileLines = new Map<string, string[]>();
  const linesOf = (rel: string): string[] => {
    if (!fileLines.has(rel)) {
      try { fileLines.set(rel, readFileSync(join(root, rel), "utf8").split("\n")); }
      catch { fileLines.set(rel, []); }
    }
    return fileLines.get(rel)!;
  };

  // The name-token position of a definition (0-indexed), scanning its first few
  // lines for the name — call hierarchy needs a position ON the symbol.
  const namePos = (src: NodeV1): { line: number; character: number } | null => {
    const sp = parseSpan(src.span); if (!sp) return null;
    const lines = linesOf(src.path);
    for (let ln = sp[0] - 1; ln < Math.min(sp[0] + 2, lines.length); ln++) {
      const c = (lines[ln] ?? "").indexOf(src.name);
      if (c >= 0) return { line: ln, character: c };
    }
    return null;
  };

  // Wait for the server to finish indexing (it answers call-hierarchy empty
  // until ready). Warm up on the first source node that has a findable position.
  const warm = sources.find((s) => namePos(s));
  if (warm) {
    const wp = namePos(warm)!;
    if (!(await client.waitUntilReady(join(root, warm.path), wp))) {
      await client.dispose();
      // Never became ready: claim nothing, so the memo doesn't record these
      // files as covered and skip them on the next build.
      return { added: 0, queried: 0, server: server.command, addedEdges, queriedFiles: new Set() };
    }
  }

  let added = 0, queried = 0;
  try {
    for (const src of sources) {
      const abs = join(root, src.path);
      client.didOpen(abs);
      const pos = namePos(src);
      if (!pos) continue;

      const items = await client.prepareCallHierarchy(abs, pos);
      if (!items.length) continue;
      queried++;
      opts.onProgress?.(queried, sources.length);
      const callees = await client.outgoingCalls(items[0]);
      for (const callee of callees) {
        let calleeAbs: string;
        try { calleeAbs = fileURLToPath(callee.uri); } catch { continue; }
        const rel = relPosix(root, calleeAbs);
        // In-repo iff the repo-relative path doesn't escape the root. (A raw
        // `startsWith(root)` is separator-unsafe: root=/a/foo matches /a/foo-bar.)
        if (rel.startsWith("..") || rel.startsWith("/")) continue; // external/dependency
        const target = nodeAt(rel, (callee.selectionRange?.start.line ?? callee.range.start.line) + 1);
        if (!target || target.id === src.id) continue;
        const key = `${src.id}\0calls\0${target.id}`;
        if (existing.has(key)) continue;
        existing.add(key);
        const edge = { source: src.id, target: target.id, relation: "calls", confidence: "lsp_resolved" } as EdgeV1;
        graph.edges.push(edge);
        addedEdges.push(edge);
        added++;
      }
    }
  } finally {
    await client.dispose().catch(() => { /* already gone */ });
  }
  return { added, queried, server: server.command, addedEdges, queriedFiles };
}
