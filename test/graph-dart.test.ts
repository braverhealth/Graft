/**
 * Tests for Dart extraction in the Tier-1 code graph. Dart is a breadth-tier
 * language, so everything here comes from `queries/dart.scm` via the generic
 * tags path. Without that query Dart falls back to the node-kind walker, which
 * names its callables `function_signature`/`method_signature` — suffixes the
 * walker's DEF_SUFFIX doesn't match — so it emits no functions, no methods and
 * no call edges at all, while promoting fields and locals to classes. These
 * assertions pin down that the query fixes each of those.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildGraph } from "../src/graph/build.js";
import { readGraph, wiringPath } from "../src/graph/write.js";
import type { GraphV1, NodeV1 } from "../src/graph/types.js";

const APP_DART = `typedef Handler = void Function(String s);

const int topLevelConst = 3;

int compute() => 42;

enum Color { red, green }

mixin Loggable {
  void log(String m) {}
}

abstract class Base {
  void doThing();
}

class Widget extends Base with Loggable implements Comparable<Widget> {
  Widget(this.name);

  final String name;
  static const kMax = 10;

  int get length => name.length;
  set length(int v) {}

  @override
  void doThing() {
    log('hi');
    compute();
    final w = Widget('x');
    w.doThing();
  }
}

extension StringX on String {
  String shout() => toUpperCase();
}
`;

function buildDartGraph(): { graph: GraphV1; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "graft-dart-"));
  mkdirSync(join(dir, "lib"), { recursive: true });
  writeFileSync(join(dir, "lib", "app.dart"), APP_DART);
  return { graph: null as unknown as GraphV1, dir };
}

const namesOfKind = (nodes: NodeV1[], kind: string) =>
  nodes.filter((n) => n.kind === kind).map((n) => n.name).sort();

test("dart extraction emits callables, types and call edges", async () => {
  const { dir } = buildDartGraph();
  try {
    await buildGraph(dir, {});
    const graph = readGraph(wiringPath(join(dir, "graft")))!;
    assert.ok(graph, "graph was written");

    const dartNodes = graph.nodes.filter((n) => n.path.endsWith(".dart"));

    // The walker fallback produced neither of these kinds for Dart.
    const methods = namesOfKind(dartNodes, "method");
    assert.ok(methods.includes("doThing"), `methods: ${methods.join(", ")}`);
    assert.ok(methods.includes("log"), `methods: ${methods.join(", ")}`);
    assert.ok(methods.includes("shout"), `methods: ${methods.join(", ")}`);
    // A getter and a setter are both members, not fields.
    assert.equal(methods.filter((m) => m === "length").length, 2);
    // The unnamed constructor is a member of its class.
    assert.ok(methods.includes("Widget"), `methods: ${methods.join(", ")}`);

    const functions = namesOfKind(dartNodes, "function");
    assert.deepEqual(functions, ["compute"]);

    const classes = namesOfKind(dartNodes, "class");
    assert.deepEqual(classes, ["Base", "StringX", "Widget"]);
    // `Comparable` is named by an implements clause, not defined here, and the
    // extension's `on String` names a type it does not define either.
    assert.ok(!classes.includes("Comparable"));
    assert.ok(!classes.includes("String"));

    assert.deepEqual(namesOfKind(dartNodes, "interface"), ["Loggable"]);
    assert.deepEqual(namesOfKind(dartNodes, "enum"), ["Color"]);
    assert.deepEqual(namesOfKind(dartNodes, "type"), ["Handler"]);

    const constants = namesOfKind(dartNodes, "constant");
    assert.ok(constants.includes("topLevelConst"));
    assert.ok(constants.includes("kMax"));
    // Enum constants are members of the enum, not separate enums.
    assert.ok(constants.includes("red") && constants.includes("green"));

    // Fields are variables; locals inside a body are not graph nodes at all.
    assert.deepEqual(namesOfKind(dartNodes, "variable"), ["name"]);

    // Call and supertype edges — the walker emitted none.
    const edges = graph.edges.filter((e) => e.source.endsWith(".dart") || e.source.includes(".dart#"));
    assert.ok(edges.length > 0, "dart edges were emitted");
    const calls = edges.filter((e) => e.relation === "calls").map((e) => e.target);
    assert.ok(calls.some((t) => t.endsWith("#compute")), `calls: ${calls.join(", ")}`);
    const refs = edges.filter((e) => e.relation === "references").map((e) => e.target);
    assert.ok(refs.some((t) => t.endsWith("#Base")), `refs: ${refs.join(", ")}`);
    assert.ok(refs.some((t) => t.endsWith("#Loggable")), `refs: ${refs.join(", ")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
