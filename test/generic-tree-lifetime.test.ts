/**
 * The breadth tier allocates a web-tree-sitter Parser and Tree per file. Both
 * live in the wasm heap and are released only by an explicit delete(), so
 * extractGeneric frees them on every path out.
 *
 * What that must NOT do is disturb the results: every node and edge is built
 * while the tree is alive and holds only primitives copied out of `source`, so
 * freeing before returning is safe. These assertions pin that down — a tree or
 * parser deleted too early would surface here as missing or empty output rather
 * than as a crash.
 *
 * The memory win itself is not asserted here because it isn't reachable from a
 * unit test: re-parsing one small source reuses the same wasm allocations, and
 * the leak only tells at repo scale (on a 12,652-file monorepo the fix lowered
 * peak RSS from 3.64 GB to 2.94 GB).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { warmGenericGrammars, extractGeneric, isWarm } from "../src/graph/generic.js";

const SOURCE = `defmodule Sample do
  @moduledoc "A module with enough shape to build a real syntax tree."

  def run(arg) do
    arg
    |> normalize()
    |> Enum.map(fn item -> transform(item) end)
  end

  defp normalize(value) when is_binary(value), do: String.trim(value)
  defp transform(item), do: %{item | seen: true}
end
`;

test("extraction survives freeing the tree, and is stable across many files", async () => {
  await warmGenericGrammars(new Set(["elixir"]));
  assert.ok(isWarm("elixir"), "elixir grammar warmed");

  const first = extractGeneric("sample/0.ex", SOURCE, "elixir");
  assert.ok(first.nodes.length > 1, "symbols were extracted");
  assert.ok(first.rawEdges.length > 0, "call edges were extracted");
  // Node fields must be real values, not views onto freed wasm memory.
  for (const node of first.nodes) {
    assert.equal(typeof node.name, "string");
    assert.ok(node.name.length > 0);
    assert.match(node.span, /^L\d+-L\d+$/);
  }

  // A parser and tree are allocated and freed per call; the 200th must agree
  // with the 1st in every particular.
  for (let i = 1; i < 200; i++) {
    const again = extractGeneric("sample/0.ex", SOURCE, "elixir");
    assert.deepEqual(again.nodes, first.nodes, `iteration ${i} nodes`);
    assert.deepEqual(again.rawEdges, first.rawEdges, `iteration ${i} edges`);
  }
});

test("a grammar with no warmed language still returns a file node", async () => {
  // The early-return path frees the parser too; it must stay a clean no-op.
  const { nodes, rawEdges } = extractGeneric("x/y.cobol", "IDENTIFICATION DIVISION.", "cobol");
  assert.equal(nodes.length, 1);
  assert.equal(nodes[0].kind, "file");
  assert.deepEqual(rawEdges, []);
});
