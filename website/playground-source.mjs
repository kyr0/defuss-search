/**
 * The playground's runner, without a Worker: it turns the import statements of an edited snippet into lookups in a
 * fixed module table, runs the rest as an async function and collects what it logs. website/playground-worker.mjs
 * runs it in a Worker with the bundled modules; test/playground.test.mjs runs every example snippet through it with
 * the same packages, so the examples on the page are known to work.
 * Why a rewrite of the imports and not a module blob with an import map: a Worker cannot resolve bare specifiers,
 * and the snippet should read like code a reader copies into a project.
 * Only the static import forms are understood (default, named, namespace, and default with named); anything else is
 * left in place and fails as a syntax error, with the module names in the message.
 * VERIFIED: test/playground.test.mjs runs every example through it; make e2e compares the page's output.
 */
const IMPORT = /^[ \t]*import\s+([\w$]+\s*,\s*\{[^}]*\}|\{[^}]*\}|\*\s*as\s+[\w$]+|[\w$]+)\s+from\s+(['"])([^'"\n]+)\2[ \t]*;?/gm;

/** `{ a, b as c }` as the destructuring `{ a, b: c }`. */
const named = (clause) =>
  clause
    .replace(/^\{|\}$/g, '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, alias] = part.split(/\s+as\s+/);
      return alias ? `${name}: ${alias}` : name;
    })
    .join(', ');

/**
 * The snippet with every import replaced by `const` lookups through `__module(name)`, on the same lines, so the
 * line numbers of an error still match the editor. Throws for a module outside `available`.
 */
export function rewriteImports(code, available) {
  return code.replace(IMPORT, (statement, clause, _quote, name) => {
    if (!available.includes(name))
      throw new Error(`The playground has no module "${name}". Available: ${available.join(', ')}`);
    const lines = '\n'.repeat((statement.match(/\n/g) ?? []).length);
    const source = `__module(${JSON.stringify(name)})`;
    const trimmed = clause.trim();
    if (trimmed.startsWith('*')) return `const ${trimmed.replace(/^\*\s*as\s+/, '')} = ${source};${lines}`;
    if (trimmed.startsWith('{')) return `const { ${named(trimmed)} } = ${source};${lines}`;
    const [defaultName, rest] = trimmed.split(/\s*,\s*(?=\{)/);
    return `const ${defaultName} = ${source}.default;${rest ? ` const { ${named(rest)} } = ${source};` : ''}${lines}`;
  });
}

/** A value as the console shows it: strings plain at the top, everything else close to JavaScript literals. */
export function inspect(value, depth = 0, seen = new WeakSet()) {
  if (typeof value === 'string') return depth ? JSON.stringify(value) : value;
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined)
    return String(value);
  if (typeof value === 'bigint') return `${value}n`;
  if (typeof value === 'function') return `[Function ${value.name || 'anonymous'}]`;
  if (typeof value === 'symbol') return value.toString();
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  if (seen.has(value)) return '[Circular]';
  if (depth > 4) return Array.isArray(value) ? '[Array]' : '[Object]';
  seen.add(value);
  const pad = '  '.repeat(depth + 1);
  const close = '  '.repeat(depth);
  let parts;
  let open = '{';
  let end = '}';
  if (Array.isArray(value)) {
    parts = value.map((item) => inspect(item, depth + 1, seen));
    open = '[';
    end = ']';
  } else if (value instanceof Map) {
    parts = [...value].map(([key, item]) => `${inspect(key, depth + 1, seen)} => ${inspect(item, depth + 1, seen)}`);
    open = `Map(${value.size}) {`;
  } else if (value instanceof Set) {
    parts = [...value].map((item) => inspect(item, depth + 1, seen));
    open = `Set(${value.size}) {`;
  } else {
    parts = Object.entries(value).map(
      ([key, item]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${inspect(item, depth + 1, seen)}`,
    );
  }
  seen.delete(value);
  if (!parts.length) return `${open}${end}`;
  const line = `${open} ${parts.join(', ')} ${end}`;
  return line.length + depth * 2 <= 76 && !line.includes('\n')
    ? line.replace(/^\[ /, '[').replace(/ \]$/, ']')
    : `${open}\n${parts.map((part) => pad + part).join(',\n')}\n${close}${end}`;
}

const AsyncFunction = (async () => {}).constructor;

/**
 * Runs a snippet with `modules` (name to module namespace) and returns { lines, ms, error }: each console call as
 * { level, text }, the run time, and the error message when it threw.
 */
export async function runSnippet(code, modules) {
  const lines = [];
  const record =
    (level) =>
    (...values) =>
      lines.push({ level, text: values.map((value) => inspect(value)).join(' ') });
  const console = { log: record('log'), info: record('info'), warn: record('warn'), error: record('error') };
  const started = performance.now();
  try {
    const body = rewriteImports(code, Object.keys(modules));
    await new AsyncFunction('__module', 'console', body)((name) => modules[name], console);
    return { lines, ms: performance.now() - started };
  } catch (error) {
    return { lines, ms: performance.now() - started, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
  }
}
