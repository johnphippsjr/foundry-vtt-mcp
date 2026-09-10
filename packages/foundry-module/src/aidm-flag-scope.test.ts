/**
 * Regression guard: no source file in this package may call a Document flag-accessor method
 * (getFlag / setFlag / unsetFlag) with the "aidm" scope (board #1311, bridge/README.md 0007
 * entry).
 *
 * Foundry's Document.getFlag/setFlag/unsetFlag throw "Flag scope <scope> is not valid or not
 * currently active" for any scope that is not the id of an active package (a module, the game
 * system, "core", or "world"). "aidm" is this lane's own flag namespace, not a package, so any
 * call shaped like a flag-accessor method with "aidm" as its first argument crashes every
 * adventure-import on every world -- this crashed in production on bridge 0.10.1 before this fix
 * (see bridge/README.md's 0007 entry and dnd-dm/docs for the captured stack trace). Every
 * flags.aidm.* read/write must go through readAidmFlag / aidmTagUpdatePayload in
 * adventure-import-utils.ts (a plain property read, and a document.update() dotted-path payload)
 * instead. This test scans this package's own source text for the literal call shape and fails
 * the moment it reappears anywhere, so a future patch cannot silently reintroduce it.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = dirname(fileURLToPath(import.meta.url));

// Built by concatenation, not written as a literal in this file, so this test's own source text
// never matches the pattern it is checking for.
const ACCESSOR_METHODS = ['get' + 'Flag', 'set' + 'Flag', 'unset' + 'Flag'];
const SCOPE_ARG = 'aidm';

function forbiddenPatternFor(method: string): RegExp {
  // Matches `getFlag('aidm'`, `getFlag?.('aidm'`, `getFlag("aidm"`, with any amount of
  // whitespace before the quote -- i.e. any call to the accessor with "aidm" as the scope arg,
  // regardless of optional chaining or quote style.
  return new RegExp(`${method}\\??\\.?\\(\\s*['"]${SCOPE_ARG}['"]`);
}

const FORBIDDEN_PATTERNS = ACCESSOR_METHODS.map(forbiddenPatternFor);

describe('no flag-accessor call in this package uses the "aidm" scope', () => {
  it('scans every .ts source file (excluding this guard file) for the forbidden call shape', () => {
    const selfFile = 'aidm-flag-scope.test.ts';
    const offenders: string[] = [];

    for (const entry of readdirSync(srcDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name === selfFile) continue;
      const text = readFileSync(join(srcDir, entry.name), 'utf8');
      for (const pattern of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) {
          offenders.push(`${entry.name} matches ${pattern}`);
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it('sanity-checks the detector against a known-bad snippet, so a broken pattern cannot pass silently', () => {
    const badSnippets = [
      `s.getFlag?.('aidm', 'sourcePack')`,
      `await worldScene.setFlag('aidm', 'sourcePack', packCollection);`,
      `doc.unsetFlag("aidm", "adoptedFor")`,
    ];
    for (const snippet of badSnippets) {
      expect(FORBIDDEN_PATTERNS.some(p => p.test(snippet))).toBe(true);
    }
  });

  it('does not flag the fixed pattern (plain property read / update() payload)', () => {
    const goodSnippets = [
      `doc?.flags?.aidm?.[key]`,
      `document.update({"flags.aidm.sourcePack": value})`,
      `readAidmFlag(doc, 'sourcePack')`,
    ];
    for (const snippet of goodSnippets) {
      expect(FORBIDDEN_PATTERNS.some(p => p.test(snippet))).toBe(false);
    }
  });
});
