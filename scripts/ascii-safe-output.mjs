// Post-build pass: replace any non-ASCII codepoint in the built JS files with
// its JS string-escape equivalent (\uXXXX or \u{XXXXXX}). This is necessary
// because Chrome's content-script encoding check rejects files containing
// certain Unicode noncharacters (notably U+FFFF, which Dexie hardcodes as an
// IndexedDB key-range sentinel) even though they are valid UTF-8.
//
// Replacing the literal character with an escape sequence has identical
// runtime semantics — when JS parses `"\uffff"`, it produces the same string
// value as the literal character — but the file on disk becomes pure ASCII.

import { promises as fs } from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.cwd(), '.output/chrome-mv3');

async function walk(dir) {
  const out = [];
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(p)));
    else if (p.endsWith('.js')) out.push(p);
  }
  return out;
}

function escapeNonAscii(src) {
  // Replace each non-ASCII code unit (covers BMP) with \uXXXX. We process
  // code units, not code points, so surrogate pairs naturally render as two
  // \uXXXX escapes, which is still a valid string literal.
  let out = '';
  for (let i = 0; i < src.length; i++) {
    const code = src.charCodeAt(i);
    if (code < 0x80) out += src[i];
    else out += `\\u${code.toString(16).padStart(4, '0')}`;
  }
  return out;
}

const files = await walk(root);
let changed = 0;
let bytesBefore = 0;
let bytesAfter = 0;
for (const file of files) {
  const src = await fs.readFile(file, 'utf8');
  bytesBefore += Buffer.byteLength(src, 'utf8');
  const escaped = escapeNonAscii(src);
  bytesAfter += Buffer.byteLength(escaped, 'utf8');
  if (escaped !== src) {
    await fs.writeFile(file, escaped, 'utf8');
    changed++;
    console.log(`escaped non-ASCII in ${path.relative(root, file)}`);
  }
}
console.log(
  `ascii-safe-output: ${changed}/${files.length} files modified, ` +
    `${bytesBefore} -> ${bytesAfter} bytes`,
);
