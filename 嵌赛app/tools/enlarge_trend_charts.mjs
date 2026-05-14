import fs from 'node:fs';
import path from 'node:path';

const root = path.join('D:\\codex', '嵌赛app');
const htmlPath = path.join(root, 'index.html');
const cssPath = path.join(root, 'assets', 'styles.css');
const jsPath = path.join(root, 'assets', 'app.js');

let html = fs.readFileSync(htmlPath, 'utf8');
html = html.replaceAll('width="360" height="96"', 'width="720" height="260"');
fs.writeFileSync(htmlPath, html, 'utf8');

let css = fs.readFileSync(cssPath, 'utf8');
css = css.replace('canvas { width: 100%; height: 96px; }', 'canvas { width: 100%; height: 260px; }');
if (!css.includes('.trend-grid > div > span')) {
  css += `

.trend-grid > div {
  min-height: 330px;
  padding: 24px;
}

.trend-grid > div > span {
  display: block;
  margin-bottom: 14px;
  font-size: 24px;
  font-weight: 900;
}

.trend-grid.single canvas {
  height: 360px;
}

.trend-grid.single > div {
  min-height: 440px;
}
`;
}
fs.writeFileSync(cssPath, css, 'utf8');

let js = fs.readFileSync(jsPath, 'utf8');
js = js.replace('const padding = { left: 42, right: 12, top: 14, bottom: 26 };', 'const padding = { left: 64, right: 34, top: 34, bottom: 52 };');
js = js.replace("ctx.font = '12px Microsoft YaHei, sans-serif';", "ctx.font = '16px Microsoft YaHei, sans-serif';");
js = js.replace('ctx.fillText(meta.unit, 6, 12);', 'ctx.fillText(meta.unit, 8, 24);');
js = js.replace("ctx.fillText('时间', width - 34, height - 6);", "ctx.fillText('时间', width - 48, height - 12);");
js = js.replace("ctx.fillText('最新', width - 44, height - padding.bottom + 18);", "ctx.fillText('最新', width - 58, height - padding.bottom + 32);");
js = js.replace("ctx.fillText('历史', padding.left, height - padding.bottom + 18);", "ctx.fillText('历史', padding.left, height - padding.bottom + 32);");
js = js.replace('ctx.fillText(String(value), 6, y + 4);', 'ctx.fillText(String(value), 12, y + 5);');
fs.writeFileSync(jsPath, js, 'utf8');

console.log('已放大趋势图绘制区域。');
