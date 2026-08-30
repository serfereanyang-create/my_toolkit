const assert = require('node:assert/strict');
const { buildLiteratureMatrix } = require('../electron/paper-matrix.cjs');

function run() {
  const md = buildLiteratureMatrix([
    { id: 'p1', title: 'A|B', authors: 'X;Y', year: '2026', source: 'J', doi: '10.1/x', status: '精读',
      method: 'm1\nm2', dataset: 'd', findings: 'f', limitations: 'l' },
  ]);
  assert.match(md, /^\| # \| 论文 \| 作者 \| 年份 \| 来源 \| DOI \| 状态 \| 方法 \| 数据\/样本 \| 关键发现 \| 局限 \|/m);
  assert.match(md, /A\\\|B/);           // pipe escaped
  assert.ok(!md.includes('m1\nm2'));    // newline folded
  assert.match(md, /m1 m2/);
  assert.match(md, /共 1 篇/);          // footer note

  const empty = buildLiteratureMatrix([]);
  assert.match(empty, /没有论文/);

  console.log('paper matrix tests passed');
}
run();
