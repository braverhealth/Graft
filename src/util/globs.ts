/**
 * The tiny glob subset graft needs for path exclusion.
 *
 * A dependency would be the obvious answer, but the walk is the one place every
 * entry point agrees on — build, the freshness probe, the hooks refresh — and
 * keeping its matching rules readable here is worth more than the generality a
 * matching library would add. Supported: `*` (within one segment), `?` (one
 * character), and `**` (any number of segments).
 */

/** Regex-escape everything that is not glob syntax. */
function literal(ch: string): string {
  return /[.+^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * Compile one glob to an anchored RegExp over a posix path.
 *
 * `**` spanning a separator collapses the separator too, so `dart/**\/*.g.dart`
 * matches `dart/a.g.dart` as well as `dart/x/y/a.g.dart` — the reading everyone
 * expects, and the one that makes a pattern written for nested files not
 * quietly miss the top-level ones.
 */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          out += "(?:[^/]+/)*";
          i += 2;
        } else {
          out += ".*";
          i += 1;
        }
      } else {
        out += "[^/]*";
      }
      continue;
    }
    out += ch === "?" ? "[^/]" : literal(ch);
  }
  return new RegExp(`^${out}$`);
}

/** One compiled exclusion: the pattern as written, plus what it matches against. */
interface Matcher {
  re: RegExp;
  /** Patterns naming no directory match a file's NAME, wherever it sits. */
  basenameOnly: boolean;
}

export function compileGlobs(patterns: readonly string[]): Matcher[] {
  return patterns
    .filter((p) => p.trim() !== "")
    .map((p) => ({ re: globToRegExp(p), basenameOnly: !p.includes("/") }));
}

/** Whether a repo-relative posix path matches any compiled pattern. */
export function matchesAny(relPath: string, matchers: readonly Matcher[]): boolean {
  if (matchers.length === 0) return false;
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  return matchers.some((m) => m.re.test(m.basenameOnly ? base : relPath));
}
