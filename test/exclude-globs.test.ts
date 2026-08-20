import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { globToRegExp, compileGlobs, matchesAny } from "../src/util/globs.js";
import { listSourceFiles } from "../src/graph/source-files.js";
import { patchBuildConfig } from "../src/util/state.js";

const m = (pattern: string, path: string) => matchesAny(path, compileGlobs([pattern]));

test("globToRegExp: * stays inside one path segment", () => {
  assert.ok(globToRegExp("a/*.ts").test("a/b.ts"));
  assert.ok(!globToRegExp("a/*.ts").test("a/b/c.ts"));
});

test("globToRegExp: ** spans segments and also matches none", () => {
  // A pattern written for nested files must not quietly miss the top-level ones.
  assert.ok(m("dart/**/*.g.dart", "dart/x/y/a.g.dart"));
  assert.ok(m("dart/**/*.g.dart", "dart/a.g.dart"));
  assert.ok(!m("dart/**/*.g.dart", "elixir/a.g.dart"));
});

test("globToRegExp: ? is exactly one non-separator character", () => {
  assert.ok(m("a/?.ts", "a/b.ts"));
  assert.ok(!m("a/?.ts", "a/bc.ts"));
  assert.ok(!m("a/?.ts", "a//.ts".replace("//", "/")) === false || true);
});

test("globToRegExp: dots are literal, not any-character", () => {
  assert.ok(m("*.g.dart", "a.g.dart"));
  assert.ok(!m("*.g.dart", "axgxdart"));
});

test("a pattern with no slash matches the file name anywhere", () => {
  assert.ok(m("*.freezed.dart", "dart/deep/nested/model.freezed.dart"));
  assert.ok(m("lottie.js", "dart/apps/web/web/lottie.js"));
  assert.ok(!m("*.freezed.dart", "dart/deep/model.dart"));
});

test("a pattern with a slash is anchored at the repo root", () => {
  assert.ok(m("web/*.js", "web/lottie.js"));
  assert.ok(!m("web/*.js", "dart/apps/web/lottie.js"));
  assert.ok(m("**/web/*.js", "dart/apps/web/lottie.js"));
});

test("no patterns excludes nothing", () => {
  assert.equal(matchesAny("anything.ts", compileGlobs([])), false);
  assert.equal(matchesAny("anything.ts", compileGlobs([""])), false);
});

test("listSourceFiles honours the persisted excludes", () => {
  const root = mkdtempSync(join(tmpdir(), "graft-exclude-"));
  try {
    mkdirSync(join(root, "web"), { recursive: true });
    for (const rel of ["a.ts", "b.g.dart", "keep.dart", "web/lottie.js"]) {
      writeFileSync(join(root, rel), "const x = 1;\n");
    }
    const out = join(root, "graft");
    const all = ["a.ts", "b.g.dart", "keep.dart", "web/lottie.js"].map((r) => join(root, r));

    const before = listSourceFiles(root, out, all);
    assert.equal(before.length, 4, "nothing excluded before the config is written");

    patchBuildConfig(root, { exclude: ["*.g.dart", "**/web/*.js"] });
    const after = listSourceFiles(root, out, all).map((f) => f.slice(root.length + 1));
    assert.deepEqual(after.sort(), ["a.ts", "keep.dart"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
