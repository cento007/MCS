/**
 * A deliberately small YAML writer for the F5.1 OpenAPI document.
 *
 * **Why not a YAML library.** The document is committed and checked for staleness byte for
 * byte (`pnpm api:spec:check`), so what matters most is that the same route table always
 * produces the same bytes — including key order, indentation and quoting. A general library
 * gives that too, but at the cost of a dependency the Backend does not otherwise need, in a
 * repository whose first-five-minutes property is `pnpm install && pnpm test` with nothing else
 * installed. The value space here is what `JSON.parse` produces (string, number, boolean, null,
 * array, plain object) and nothing else, which is a couple of dozen lines of emitter.
 *
 * **Quoting is conservative on purpose.** Every string that is not unambiguously plain is
 * single-quoted, which in YAML is a literal scalar with `''` as the only escape — no backslash
 * rules, no interpretation, nothing to get subtly wrong. Strings containing newlines become
 * block scalars. That gives a document that is valid YAML *and* readable, without a quoting
 * decision tree that has to be right in every case.
 */

/** Anything `JSON.parse` can produce. The document is built from exactly this. */
export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

const INDENT = '  ';

/**
 * Plain (unquoted) scalars: conservative, so nothing that YAML would reinterpret as a number,
 * a boolean, a date, a null, a tag or a flow collection can slip through unquoted.
 *
 * `/` and `$` lead the character class because half this document is paths (`/sessions/{id}`)
 * and `$ref` keys; neither is a YAML indicator, and quoting every one of them would make the
 * file harder to read for no gain. A leading digit is *not* admitted — `3.1.0` and `1.0.0` are
 * versions, and YAML would be entitled to read the first of those as a number.
 */
const PLAIN_SAFE = /^[A-Za-z_$/][A-Za-z0-9_$./-]*$/;
const RESERVED_PLAIN = new Set([
  'y',
  'Y',
  'yes',
  'Yes',
  'YES',
  'n',
  'N',
  'no',
  'No',
  'NO',
  'true',
  'True',
  'TRUE',
  'false',
  'False',
  'FALSE',
  'on',
  'On',
  'ON',
  'off',
  'Off',
  'OFF',
  'null',
  'Null',
  'NULL',
]);

function isPlainSafe(value: string): boolean {
  return PLAIN_SAFE.test(value) && !RESERVED_PLAIN.has(value);
}

function quote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function scalar(value: string | number | boolean | null): string {
  if (value === null) return 'null';
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`YAML cannot carry the number ${String(value)}`);
    const rendered = String(value);
    // JavaScript prints large magnitudes as `1e+21`; a YAML 1.1 reader wants a mantissa with a
    // decimal point (`1.0e+21`) and reads the bare form back as a *string*. Nothing in this
    // document is that large today — this is here so that the day something is, it does not
    // change type on the way through.
    return /e/i.test(rendered) && !rendered.includes('.')
      ? rendered.replace(/e/i, '.0e')
      : rendered;
  }
  return isPlainSafe(value) ? value : quote(value);
}

function isPlainObject(value: YamlValue): value is { [key: string]: YamlValue } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Render one value at `depth`, returning its lines.
 *
 * `inline` is what follows a `key:` or a `-` on the same line; block content starts on the
 * next line. Empty collections are emitted in flow form (`{}` / `[]`) because YAML has no
 * block spelling for them.
 */
function emit(value: YamlValue, depth: number, lines: string[], prefix: string): void {
  // The root is emitted at depth -1 so its keys land at column 0; nothing else is negative.
  const pad = INDENT.repeat(Math.max(depth, 0));

  if (typeof value === 'string' && value.includes('\n')) {
    // Block scalar: `|-` keeps the line breaks and strips the trailing newline. Every line is
    // indented one level past the key, which is what makes it unambiguous.
    lines.push(`${prefix}|-`);
    for (const line of value.split('\n')) {
      lines.push(line.length === 0 ? '' : `${pad}${INDENT}${line}`);
    }
    return;
  }

  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${prefix}[]`);
      return;
    }
    lines.push(prefix.trimEnd());
    for (const element of value) {
      emit(element, depth + 1, lines, `${pad}${INDENT}- `);
    }
    return;
  }

  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) {
      lines.push(`${prefix}{}`);
      return;
    }
    // An object nested under `- ` starts on the dash line; the rest of its keys line up under
    // it. Anything else starts on the line after its key.
    const startsInline = prefix.endsWith('- ');
    if (!startsInline) lines.push(prefix.trimEnd());

    const childDepth = depth + 1;
    const childPad = INDENT.repeat(childDepth);
    keys.forEach((key, index) => {
      const head = startsInline && index === 0 ? prefix : childPad;
      const child = value[key] as YamlValue;
      emit(child, childDepth, lines, `${head}${scalarKey(key)}: `);
    });
    return;
  }

  lines.push(`${prefix}${scalar(value)}`);
}

function scalarKey(key: string): string {
  return isPlainSafe(key) ? key : quote(key);
}

/** Render a document. Always ends with exactly one trailing newline. */
export function toYaml(document: YamlValue): string {
  const lines: string[] = [];
  emit(document, -1, lines, '');
  // `emit` on a root object pushes an empty first line (the trimmed prefix); drop it.
  while (lines.length > 0 && lines[0] === '') lines.shift();
  return `${lines.join('\n')}\n`;
}
