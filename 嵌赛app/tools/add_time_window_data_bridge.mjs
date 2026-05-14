import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const htmlPath = path.join(root, 'index.html');
const cssPath = path.join(root, 'assets', 'styles.css');
const jsPath = path.join(root, 'assets', 'app.js');

let html = fs.readFileSync(htmlPath, 'utf8');

if (!html.includes('time-window-input')) {
  html = html.replace(
    /(<section class="card section-card chart-mode-card">[\s\S]*?<div class="chart-config">[\s\S]*?<div class="chart-check-list"[\s\S]*?<\/div>\s*<\/div>)(\s*<\/div>\s*<\/section>)/,
    `$1
              <div class="time-window-setting">
                <span class="config-label">X 轴时间窗口</span>
                <div class="time-window-control">
                  <input id="time-window-input" type="number" min="6" max="3600" step="3" value="72" aria-label="X 轴时间窗口秒数" />
                  <span>秒</span>
                </div>
              </div>$2`
  );
}

html = html.replaceAll('width="1440" height="520"', 'width="1800" height="720"');
html = html.replaceAll('width="720" height="260"', 'width="1800" height="720"');
fs.writeFileSync(htmlPath, html, 'utf8');

let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('High resolution interactive trend chart layout')) {
  css += `

/* High resolution interactive trend chart layout */
.trend-grid,
.trend-card .trend-grid {
  grid-template-columns: 1fr !important;
  gap: 42px !important;
}

.trend-grid > div {
  width: 100%;
  min-height: 560px !important;
  padding: 30px !important;
  border: 2px solid #e5e7eb !important;
  border-radius: 30px !important;
  box-shadow: 0 22px 60px rgba(17, 24, 39, 0.10) !important;
}

.trend-grid > div + div {
  margin-top: 22px;
}

.trend-grid canvas,
.trend-grid.single canvas {
  height: 430px !important;
  image-rendering: auto;
}

.chart-config {
  display: grid !important;
  grid-template-columns: minmax(0, 1fr) 260px !important;
  gap: 18px !important;
  align-items: end;
}

.time-window-control {
  display: flex;
  align-items: center;
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 8px 12px;
  background: #fff;
  gap: 10px;
}

.time-window-control input {
  width: 100%;
  border: 0;
  outline: 0;
  background: transparent;
  font-weight: 900;
  font-size: 18px;
}

.time-window-control span {
  color: var(--muted);
  font-weight: 900;
}

@media (max-width: 860px) {
  .chart-config {
    grid-template-columns: 1fr !important;
  }
}
`;
}
fs.writeFileSync(cssPath, css, 'utf8');

let js = fs.readFileSync(jsPath, 'utf8');

js = js.replace(
  /const state = [^\n]+;/,
  "const state = { history: { co: [], alcohol: [], voc: [] }, alarms: [], events: [], current: null, account: null, chartTypes: ['co', 'alcohol', 'voc'], timeWindowSeconds: 72, sensorSampling: { co: 3, alcohol: 3, voc: 3 }, dataSource: 'mock' };"
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
        state.chartTypes = checked.slice(0, 3);
      }
      applyChartMode();
      renderTrends();
    });
  });

  const timeWindowInput = document.getElementById('time-window-input');
  if (timeWindowInput) {
    timeWindowInput.value = String(state.timeWindowSeconds);
    timeWindowInput.addEventListener('change', function () {
      state.timeWindowSeconds = clamp(Number(timeWindowInput.value || 72), 6, 3600);
      timeWindowInput.value = String(state.timeWindowSeconds);
      trimHistories();
      applyChartMode();
      renderTrends();
    });
  }

  applyChartMode();
}
function applyChartMode() {
  const selected = state.chartTypes.slice(0, 3);
  document.querySelectorAll('.trend-grid > [data-trend-key]').forEach(function (item) {
    item.hidden = !selected.includes(item.dataset.trendKey);
  });
  const grid = document.querySelector('.trend-grid');
  if (grid) grid.classList.toggle('single', selected.length === 1);
  const label = selected.map(function (key) { return chartTypeLabels[key] || key; }).join(' / ');
  setText('chart-mode-desc', '当前显示：' + label + '（' + selected.length + ' 个，窗口 ' + state.timeWindowSeconds + 's）');
}
`);

js = js.replace(/function pushHistory\(snapshot\) \{[\s\S]*?\n\}\nfunction getTrendMeta/, `function getSensorSampleInterval(sensorKey) {
  return Math.max(0.1, Number(state.sensorSampling[sensorKey] || 3));
}
function getHistoryLimit(sensorKey) {
  return Math.max(2, Math.ceil(state.timeWindowSeconds / getSensorSampleInterval(sensorKey)) + 1);
}
function trimHistories() {
  ['co', 'alcohol', 'voc'].forEach(function (key) {
    const limit = getHistoryLimit(key);
    while (state.history[key].length > limit) state.history[key].shift();
  });
}
function pushHistory(snapshot) {
  state.history.co.push(snapshot.sensors.co);
  state.history.alcohol.push(snapshot.sensors.alcohol);
  state.history.voc.push(snapshot.sensors.voc);
  trimHistories();
}
function getTrendMeta`);

const newTrendCode = `function getTrendMeta(canvasId) {
  const metaMap = {
    'trend-co': { key: 'co', name: 'CO', unit: 'ppm' },
    'trend-alcohol': { key: 'alcohol', name: '酒精', unit: 'adc' },
    'trend-voc': { key: 'voc', name: 'VOC', unit: 'index' }
  };
  return metaMap[canvasId] || { key: '', name: '', unit: '' };
}
function getChartView(canvasId) {
  if (!chartViews[canvasId]) {
    chartViews[canvasId] = {
      scaleX: 1,
      scaleY: 1,
      offsetX: 0,
      offsetY: 0,
      points: [],
      activePoint: null,
      dragging: false,
      dragged: false,
      startX: 0,
      startY: 0,
      startOffsetX: 0,
      startOffsetY: 0
    };
  }
  return chartViews[canvasId];
}
function syncCanvasResolution(canvas) {
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(3, Math.max(window.devicePixelRatio || 1, 2.5));
  const width = Math.max(320, rect.width || 1200);
  const height = Math.max(260, rect.height || 430);
  const targetWidth = Math.round(width * dpr);
  const targetHeight = Math.round(height * dpr);
  if (canvas.width !== targetWidth || canvas.height !== targetHeight) {
    canvas.width = targetWidth;
    canvas.height = targetHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}
function getPlotArea(width, height) {
  const padding = { left: 98, right: 66, top: 56, bottom: 92 };
  return {
    left: padding.left,
    right: width - padding.right,
    top: padding.top,
    bottom: height - padding.bottom,
    width: width - padding.left - padding.right,
    height: height - padding.top - padding.bottom
  };
}
function getCanvasPointer(event, canvas) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top
  };
}
function isInsidePlot(point, area) {
  return point.x >= area.left && point.x <= area.right && point.y >= area.top && point.y <= area.bottom;
}
function findNearestPoint(view, point) {
  let nearest = null;
  let nearestDistance = Infinity;
  view.points.forEach(function (item) {
    const distance = Math.hypot(item.x - point.x, item.y - point.y);
    if (distance < nearestDistance) {
      nearest = item;
      nearestDistance = distance;
    }
  });
  return nearestDistance <= 18 ? nearest : null;
}
function setupChartInteractions() {
  ['trend-co', 'trend-alcohol', 'trend-voc'].forEach(function (canvasId) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return;
    const view = getChartView(canvasId);

    canvas.addEventListener('pointerdown', function (event) {
      const point = getCanvasPointer(event, canvas);
      const size = syncCanvasResolution(canvas);
      const area = getPlotArea(size.width, size.height);
      if (!isInsidePlot(point, area)) return;
      view.dragging = true;
      view.dragged = false;
      view.startX = point.x;
      view.startY = point.y;
      view.startOffsetX = view.offsetX;
      view.startOffsetY = view.offsetY;
      canvas.classList.add('dragging');
      canvas.setPointerCapture(event.pointerId);
    });

    canvas.addEventListener('pointermove', function (event) {
      if (!view.dragging) return;
      const point = getCanvasPointer(event, canvas);
      const dx = point.x - view.startX;
      const dy = point.y - view.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) view.dragged = true;
      view.offsetX = view.startOffsetX + dx;
      view.offsetY = view.startOffsetY + dy;
      renderTrends();
    });

    canvas.addEventListener('pointerup', function (event) {
      const point = getCanvasPointer(event, canvas);
      if (!view.dragged) {
        const nearest = findNearestPoint(view, point);
        view.activePoint = nearest;
        renderTrends();
      }
      view.dragging = false;
      canvas.classList.remove('dragging');
      try { canvas.releasePointerCapture(event.pointerId); } catch (error) {}
    });

    canvas.addEventListener('pointerleave', function () {
      if (!view.dragging) return;
      view.dragging = false;
      canvas.classList.remove('dragging');
    });

    canvas.addEventListener('wheel', function (event) {
      const point = getCanvasPointer(event, canvas);
      const size = syncCanvasResolution(canvas);
      const area = getPlotArea(size.width, size.height);
      if (!isInsidePlot(point, area)) return;
      event.preventDefault();
      const factor = event.deltaY < 0 ? 1.12 : 0.88;
      const nextScaleX = clamp(view.scaleX * factor, 0.55, 8);
      const nextScaleY = clamp(view.scaleY * factor, 0.55, 8);
      const contentX = (point.x - area.left - view.offsetX) / view.scaleX;
      const contentY = (point.y - area.top - view.offsetY) / view.scaleY;
      view.offsetX = point.x - area.left - contentX * nextScaleX;
      view.offsetY = point.y - area.top - contentY * nextScaleY;
      view.scaleX = nextScaleX;
      view.scaleY = nextScaleY;
      renderTrends();
    }, { passive: false });

    canvas.addEventListener('dblclick', function () {
      view.scaleX = 1;
      view.scaleY = 1;
      view.offsetX = 0;
      view.offsetY = 0;
      view.activePoint = null;
      renderTrends();
    });
  });
}
function drawTooltip(ctx, point, area, meta) {
  const valueText = 'y=' + point.value + (meta.unit ? ' ' + meta.unit : '');
  const indexText = 'x=-' + point.secondsAgo + 's · 点位 #' + (point.index + 1);
  ctx.save();
  ctx.font = '16px Microsoft YaHei, sans-serif';
  const width = Math.max(ctx.measureText(valueText).width, ctx.measureText(indexText).width) + 24;
  const height = 58;
  let x = point.x + 14;
  let y = point.y - height - 14;
  if (x + width > area.right) x = point.x - width - 14;
  if (y < area.top) y = point.y + 14;
  ctx.fillStyle = 'rgba(17, 24, 39, 0.92)';
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, 14);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(valueText, x + 12, y + 24);
  ctx.fillStyle = '#d1d5db';
  ctx.fillText(indexText, x + 12, y + 46);
  ctx.restore();
}
function drawTrend(canvasId, values, color) {
  const canvas = document.getElementById(canvasId);
  if (!canvas) return;
  const size = syncCanvasResolution(canvas);
  const ctx = size.ctx;
  const width = size.width;
  const height = size.height;
  const area = getPlotArea(width, height);
  const maxRaw = Math.max.apply(null, values.concat([1]));
  const minRaw = Math.min.apply(null, values.concat([0]));
  const max = Math.ceil(maxRaw / 10) * 10 || 10;
  const min = Math.max(0, Math.floor(minRaw / 10) * 10);
  const range = Math.max(max - min, 1);
  const meta = getTrendMeta(canvasId);
  const view = getChartView(canvasId);
  const sampleInterval = getSensorSampleInterval(meta.key);

  ctx.clearRect(0, 0, width, height);
  ctx.font = '16px Microsoft YaHei, sans-serif';
  ctx.lineWidth = 1;

  ctx.strokeStyle = '#e5e7eb';
  ctx.fillStyle = '#737373';
  for (let i = 0; i <= 4; i += 1) {
    const y = area.top + (area.height / 4) * i;
    const value = Math.round(max - (range / 4) * i);
    ctx.beginPath();
    ctx.moveTo(area.left, y);
    ctx.lineTo(area.right, y);
    ctx.stroke();
    ctx.fillText(String(value) + (meta.unit ? ' ' + meta.unit : ''), 12, y + 5);
  }

  ctx.strokeStyle = '#9ca3af';
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(area.left, area.top);
  ctx.lineTo(area.left, area.bottom);
  ctx.lineTo(area.right, area.bottom);
  ctx.stroke();

  ctx.fillStyle = '#737373';
  ctx.fillText(meta.unit, 8, 24);
  ctx.fillText('时间 / 秒', width - 92, height - 12);
  for (let i = 0; i <= 4; i += 1) {
    const x = area.left + (area.width / 4) * i;
    const secondsAgo = Math.round(state.timeWindowSeconds - (state.timeWindowSeconds / 4) * i);
    const label = i === 4 ? '0s' : '-' + secondsAgo + 's';
    ctx.fillText(label, x - 14, height - 42);
  }
  ctx.fillText('历史', area.left, height - 12);
  ctx.fillText('最新', area.right - 44, height - 12);

  view.points = [];
  if (values.length < 2) return;

  ctx.save();
  ctx.beginPath();
  ctx.rect(area.left, area.top, area.width, area.height);
  ctx.clip();

  ctx.strokeStyle = color;
  ctx.lineWidth = 4.5;
  ctx.beginPath();
  values.forEach(function (value, index) {
    const secondsAgo = Math.max(0, Math.round((values.length - 1 - index) * sampleInterval));
    const baseX = area.right - (secondsAgo / state.timeWindowSeconds) * area.width;
    const baseY = area.top + area.height - ((value - min) / range) * area.height;
    const x = area.left + (baseX - area.left) * view.scaleX + view.offsetX;
    const y = area.top + (baseY - area.top) * view.scaleY + view.offsetY;
    view.points.push({ x, y, value, index, secondsAgo });
    if (index === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  });
  ctx.stroke();

  view.points.forEach(function (point) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
    ctx.fill();
  });

  if (view.activePoint) {
    ctx.strokeStyle = 'rgba(17, 24, 39, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(view.activePoint.x, area.top);
    ctx.lineTo(view.activePoint.x, area.bottom);
    ctx.stroke();
    ctx.fillStyle = '#111827';
    ctx.beginPath();
    ctx.arc(view.activePoint.x, view.activePoint.y, 7, 0, Math.PI * 2);
    ctx.fill();
    drawTooltip(ctx, view.activePoint, area, meta);
  }

  ctx.restore();
}
function renderTrends`;

js = js.replace(/function getTrendMeta\(canvasId\) \{[\s\S]*?\n\}\nfunction renderTrends/, newTrendCode);

js = js.replace("function tick() { render(buildSnapshot()); }", "function tick() { if (state.dataSource === 'mock') render(buildSnapshot()); }");

if (!js.includes('window.LabSafeDataBridge')) {
  const bridgeCode = `
window.LabSafeDataBridge = {
  setDataSource: function (source) {
    state.dataSource = source || 'mock';
  },
  setTimeWindow: function (seconds) {
    state.timeWindowSeconds = clamp(Number(seconds || 72), 6, 3600);
    const input = document.getElementById('time-window-input');
    if (input) input.value = String(state.timeWindowSeconds);
    trimHistories();
    applyChartMode();
    renderTrends();
  },
  setSensorSampling: function (sensorKey, seconds) {
    if (!state.sensorSampling[sensorKey]) return;
    state.sensorSampling[sensorKey] = Math.max(0.1, Number(seconds || 3));
    trimHistories();
    renderTrends();
  },
  pushSensorSample: function (sensorKey, value) {
    if (!state.history[sensorKey]) return;
    state.dataSource = 'external';
    state.history[sensorKey].push(Number(value || 0));
    trimHistories();
    renderTrends();
  },
  ingestSnapshot: function (snapshot) {
    state.dataSource = 'external';
    render(snapshot);
  },
  getState: function () {
    return state;
  }
};
`;
  js = js.replace('setupAuth();', bridgeCode + '\nsetupAuth();');
}

fs.writeFileSync(jsPath, js, 'utf8');

console.log('已提高图表清晰度，加入 X 轴时间窗口输入和后续数据接入接口。');
