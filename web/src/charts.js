import { Chart, registerables } from 'chart.js';

Chart.register(...registerables);
Chart.defaults.color = '#475467';
Chart.defaults.borderColor = '#e2e7ef';
Chart.defaults.font.family = 'Inter, system-ui, sans-serif';

const charts = new Map();

export function drawChart(canvas, config) {
  charts.get(canvas)?.destroy();
  const chart = new Chart(canvas, { ...config, options: { responsive: true, maintainAspectRatio: false, animation: false, ...config.options } });
  charts.set(canvas, chart);
  return chart;
}

export function movingAverage(values, window = 50) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= window) sum -= values[i - window];
    out.push(+(sum / Math.min(i + 1, window)).toFixed(3));
  }
  return out;
}

export const COLORS = { red: '#e5484d', blue: '#2f6fed', grey: '#b8c1cf', purple: '#7c4dff', gold: '#f5b300' };
