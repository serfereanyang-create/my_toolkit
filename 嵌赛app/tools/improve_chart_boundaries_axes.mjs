import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const cssPath = path.join(root, 'assets', 'styles.css');
const jsPath = path.join(root, 'assets', 'app.js');

let css = fs.readFileSync(cssPath, 'utf8');
if (!css.includes('Clear chart boundaries and spacing')) {
  css += `

/* Clear chart boundaries and spacing */
.trend-grid {
  gap: 34px !important;
}

.trend-grid > div {
  border: 2px solid #e5e7eb !important;
  border-radius: 28px !important;
  box-shadow: 0 18px 45px rgba(17, 24, 39, 0.08) !important;
  margin-bottom: 8px;
}

.trend-grid > div + div {
  margin-top: 18px;
}
`;
}
fs.writeFileSync(cssPath, css, 'utf8');

let js = fs.readFileSync(jsPath, 'utf8');
js = js.replace(
  "const padding = { left: 76, right: 42, top: 38, bottom: 58 };",
  "const padding = { left: 92, right: 58, top: 48, bottom: 82 };"
);
js = js.replace(
  "ctx.fillText('时间', width - 52, height - 12);\n  ctx.fillText('历史', area.left, height - 20);\n  ctx.fillText('最新', area.right - 44, height - 20);",
  "ctx.fillText('时间 / 秒', width - 92, height - 12);\n  for (let i = 0; i <= 4; i += 1) {\n    const x = area.left + (area.width / 4) * i;\n    const secondsAgo = Math.round((4 - i) * 18);\n    const label = i === 4 ? '0s' : '-' + secondsAgo + 's';\n    ctx.fillText(label, x - 12, height - 42);\n  }\n  ctx.fillText('历史', area.left, height - 12);\n  ctx.fillText('最新', area.right - 44, height - 12);"
);
js = js.replace(
  "ctx.fillText(String(value), 12, y + 5);",
  "ctx.fillText(String(value) + (meta.unit ? ' ' + meta.unit : ''), 12, y + 5);"
);
js = js.replace(
  "ctx.fillText(String(latest.value), Math.max(area.left, latest.x - 30), Math.max(area.top + 18, latest.y - 10));",
  "ctx.fillText('y=' + latest.value + (meta.unit ? ' ' + meta.unit : ''), Math.max(area.left, latest.x - 68), Math.max(area.top + 18, latest.y - 10));"
);
js = js.replace(
  "const valueText = meta.name + ': ' + point.value + (meta.unit ? ' ' + meta.unit : '');\n  const indexText = '点位 #' + (point.index + 1);",
  "const valueText = 'y=' + point.value + (meta.unit ? ' ' + meta.unit : '');\n  const secondsAgo = Math.max(0, (state.history.co.length - 1 - point.index) * 3);\n  const indexText = 'x=-' + secondsAgo + 's · 点位 #' + (point.index + 1);"
);
fs.writeFileSync(jsPath, js, 'utf8');

console.log('已增加图表边界、间距和坐标数值标注。');
