/**
 * The value axis of a chart of shares (recall, 0 to 1): it spans the plotted values with 5 points to spare on each
 * side, within 0% and 100%, widened to the next tick of 1, 2, 5, 10 or 20 points, the finest that needs at most 7
 * steps. Why not a fixed 0-to-100% axis: the factories differ by a few points on most query sets, which a full axis
 * flattens into one line; why ticks at the ends: an axis that stops between two ticks shows an unlabelled edge, or
 * a label crowding its neighbour.
 * VERIFIED: test/axis.test.mjs checks the padding, the bounds and the step on the published value ranges.
 */
const STEPS = [1, 2, 5, 10, 20];

export function shareAxis(values) {
  // Whole tenths of a point, so 0.967 is 96.7 and not 96.69999.
  const points = values.map((value) => Math.round(value * 1000) / 10);
  const lowest = Math.max(0, Math.min(...points) - 5);
  const highest = Math.min(100, Math.max(...points) + 5);
  for (const step of STEPS) {
    const min = Math.floor(lowest / step) * step;
    const max = Math.ceil(highest / step) * step;
    if ((max - min) / step <= 7 || step === STEPS.at(-1)) return { min: min / 100, max: max / 100, interval: step / 100 };
  }
}
