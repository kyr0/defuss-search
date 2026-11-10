/**
 * The ECharts runtime the defuss-shadcn chart component draws with (it reads globalThis.echarts), trimmed to what
 * the performance section uses: bar and scatter series, axes, legends, tooltips, the ARIA description and the label
 * layout that moves overlapping labels apart, drawn as SVG.
 * Loaded the first time a chart comes near the viewport (website/charts.mjs).
 * VERIFIED: make e2e draws all four charts with these parts and no console error.
 */
import { BarChart, ScatterChart } from 'echarts/charts';
import { AriaComponent, GridComponent, LegendComponent, TooltipComponent } from 'echarts/components';
import { LabelLayout } from 'echarts/features';
import * as echarts from 'echarts/core';
import { SVGRenderer } from 'echarts/renderers';

echarts.use([
  BarChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TooltipComponent,
  AriaComponent,
  LabelLayout,
  SVGRenderer,
]);
globalThis.echarts = echarts;
export default echarts;
