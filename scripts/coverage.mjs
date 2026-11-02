/**
 * VERIFIED: line and function coverage of the compiled package (dist/) from Bun's LCOV, enforced at 80%.
 * Measuring dist/ rather than src/ covers the code that consumers import.
 */
import { readFile, writeFile } from 'node:fs/promises';
const content = await readFile('output/coverage/lcov.info', 'utf8');
const files = content
  .split('end_of_record')
  .filter((x) => /^SF:dist\//m.test(x))
  .map((record) => {
    const file = record.match(/^SF:(.+)$/m)[1];
    const lines = [...record.matchAll(/^DA:\d+,(\d+)/gm)].map((x) => Number(x[1]));
    const functions = Number(record.match(/^FNF:(\d+)/m)?.[1] ?? 0),
      hitFunctions = Number(record.match(/^FNH:(\d+)/m)?.[1] ?? 0);
    return {
      file,
      lines: lines.length,
      hitLines: lines.filter((x) => x > 0).length,
      functions,
      hitFunctions,
    };
  });
if (!files.length) throw new Error('Missing package coverage');
const totals = files.reduce(
  (sum, row) => ({
    lines: sum.lines + row.lines,
    hitLines: sum.hitLines + row.hitLines,
    functions: sum.functions + row.functions,
    hitFunctions: sum.hitFunctions + row.hitFunctions,
  }),
  { lines: 0, hitLines: 0, functions: 0, hitFunctions: 0 },
);
const report = {
  scope: 'Compiled public package and shared chunks; Bun LCOV. Includes adapter integration tests.',
  ...totals,
  linePercent: (100 * totals.hitLines) / totals.lines,
  functionPercent: (100 * totals.hitFunctions) / totals.functions,
  files,
};
if (report.linePercent < 80 || report.functionPercent < 80)
  throw new Error(`Coverage below 80%: ${JSON.stringify(report)}`);
await writeFile('output/coverage-summary.json', JSON.stringify(report, null, 2) + '\n');
console.log(`TOTAL ${report.linePercent.toFixed(2)}%`);
console.log(
  `Coverage: ${report.linePercent.toFixed(1)}% lines, ${report.functionPercent.toFixed(1)}% functions.`,
);
