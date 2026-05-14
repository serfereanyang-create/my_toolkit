import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const htmlPath = path.join(root, 'index.html');
const cssPath = path.join(root, 'assets', 'styles.css');
const jsPath = path.join(root, 'assets', 'app.js');

let html = fs.readFileSync(htmlPath, 'utf8');

html = html.replace(/\s*<section id="page-data" class="page-section">[\s\S]*?<section class="card section-card">\s*<div class="section-head">\s*<div>\s*<p class="eyebrow">Raw Data<\/p>/, `
        <section id="page-data" class="page-section">
          <section class="card section-card trend-card">
            <div class="section-head">
              <div>
                <p class="eyebrow">Trends</p>
                <h2>最近数据趋势</h2>
              </div>
            </div>
            <div class="trend-grid">
              <div data-trend-key="co"><span>CO</span><canvas id="trend-co" width="360" height="96"></canvas></div>
              <div data-trend-key="alcohol"><span>酒精气体</span><canvas id="trend-alcohol" width="360" height="96"></canvas></div>
              <div data-trend-key="voc"><span>VOC</span><canvas id="trend-voc" width="360" height="96"></canvas></div>
            </div>
          </section>

          <section class="card section-card chart-mode-card">
            <div class="section-head compact">
              <div>
                <p class="eyebrow">Chart Mode</p>
                <h2>曲线显示模式</h2>
              </div>
              <span id="chart-mode-desc">当前显示：全部曲线</span>
            </div>
            <div class="chart-config">
              <div>
                <span class="config-label">曲线类型</span>
                <div class="chart-check-list" aria-label="实时曲线类型选择">
                  <label><input class="chart-type-check" type="checkbox" value="co" checked /> CO</label>
                  <label><input class="chart-type-check" type="checkbox" value="alcohol" checked /> 酒精</label>
                  <label><input class="chart-type-check" type="checkbox" value="voc" checked /> VOC</label>
                </div>
              </div>
              <div>
                <span class="config-label">渲染数目</span>
                <select id="chart-count-select" class="chart-count-select" aria-label="选择渲染曲线图数目">
                  <option value="1">1 个</option>
                  <option value="2">2 个</option>
                  <option value="3" selected>3 个</option>
                </select>
              </div>
            </div>
          </section>

          <section class="card section-card device-card-below">
            <div class="section-head compact">
              <div>
                <p class="eyebrow">Device</p>
                <h2>设备运行状态</h2>
              </div>
            </div>
            <div id="device-list" class="status-list device-status-grid"></div>
          </section>

          <section class="card section-card">
            <div class="section-head">
              <div>
                <p class="eyebrow">Raw Data</p>`);

fs.writeFileSync(htmlPath, html, 'utf8');

let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('.chart-config')) {
  css += `

.trend-card .trend-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

.trend-card .trend-grid.single {
  grid-template-columns: minmax(0, 1fr);
}

.chart-config {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 180px;
  gap: 18px;
}

.config-label {
  display: block;
  margin-bottom: 10px;
  color: var(--muted);
  font-weight: 800;
}

.chart-check-list {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
}

.chart-check-list label {
  display: inline-flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 999px;
  padding: 10px 16px;
  background: #fff;
  cursor: pointer;
  gap: 8px;
  font-weight: 900;
}

.chart-check-list input {
  width: 18px;
  height: 18px;
  accent-color: var(--pink);
}

.chart-count-select {
  width: 100%;
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 11px 14px;
  background: #fff;
  font-weight: 900;
  outline: none;
}

.device-status-grid {
  grid-template-columns: repeat(3, minmax(0, 1fr));
}

@media (max-width: 860px) {
  .chart-config,
  .device-status-grid {
    grid-template-columns: 1fr;
  }
}
`;
}
fs.writeFileSync(cssPath, css, 'utf8');

let js = fs.readFileSync(jsPath, 'utf8');
js = js.replace(
  /const state = \{ history: \{ co: \[\], alcohol: \[\], voc: \[\] \}, alarms: \[\], events: \[\], current: null, account: null, chartMode: 'all' \};/,
  "const state = { history: { co: [], alcohol: [], voc: [] }, alarms: [], events: [], current: null, account: null, chartTypes: ['co', 'alcohol', 'voc'], chartCount: 3 };"
);
js = js.replace(
  /const chartModeLabels = \{ all: '全部曲线', co: 'CO 曲线', alcohol: '酒精曲线', voc: 'VOC 曲线' \};/,
  "const chartTypeLabels = { co: 'CO', alcohol: '酒精', voc: 'VOC' };"
);
js = js.replace(/function setupChartModeSelector\(\) \{[\s\S]*?\n\}\nfunction applyChartMode\(\) \{[\s\S]*?\n\}\n/, `function setupChartModeSelector() {
  document.querySelectorAll('.chart-type-check').forEach(function (checkbox) {
    checkbox.addEventListener('change', function () {
      const checked = Array.from(document.querySelectorAll('.chart-type-check:checked')).map(function (item) {
        return item.value;
      });
      if (checked.length === 0) {
        checkbox.checked = true;
        state.chartTypes = [checkbox.value];
      } else {
        state.chartTypes = checked;
      }
      applyChartMode();
      renderTrends();
    });
  });

  const countSelect = document.getElementById('chart-count-select');
  countSelect.addEventListener('change', function () {
    state.chartCount = Math.min(3, Math.max(1, Number(countSelect.value || 3)));
    applyChartMode();
    renderTrends();
  });

  applyChartMode();
}
function applyChartMode() {
  const selected = state.chartTypes.slice(0, state.chartCount);
  document.querySelectorAll('.trend-grid > [data-trend-key]').forEach(function (item) {
    item.hidden = !selected.includes(item.dataset.trendKey);
  });
  const grid = document.querySelector('.trend-grid');
  if (grid) grid.classList.toggle('single', selected.length === 1);
  const label = selected.map(function (key) { return chartTypeLabels[key] || key; }).join(' / ');
  setText('chart-mode-desc', '当前显示：' + label + '（' + selected.length + ' 个）');
}
`);
js = js.replace("if (page === 'data') { renderTrends(); applyChartMode(); }", "if (page === 'data') { renderTrends(); applyChartMode(); }");
fs.writeFileSync(jsPath, js, 'utf8');

console.log('已调整曲线选择与设备状态布局。');
