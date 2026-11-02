/** VERIFIED: make metrics prints the published per-language R@k of both presets from docs/data/recall.json. */
import { readFile } from 'node:fs/promises';
const recall = JSON.parse(await readFile('docs/data/recall.json', 'utf8'));
const percent = (share) => `${(100 * share).toFixed(0)}%`;
for (const preset of recall.presets) {
  console.log(`${preset.name}: ${preset.description}`);
  console.table(
    Object.fromEntries(
      Object.entries(preset.languages).map(([code, row]) => [
        recall.languages[code].name,
        {
          'R@1': percent(row.r1),
          'R@5': percent(row.r5),
          'R@10': percent(row.r10),
          'R@25': percent(row.r25),
        },
      ]),
    ),
  );
}
