const assert = require('node:assert/strict');
const { buildReviewDigest } = require('../electron/paper-digest.cjs');

const paper = (overrides = {}) => ({
  id: 'p', title: 'T', authors: 'A', year: '2026', source: 'S', doi: '', url: '',
  status: '精读', tags: ['nlp'], question: 'Q', method: 'M', dataset: 'D',
  findings: 'F', limitations: 'L', credibility: 'C',
  evidence: [{ id: 'e1', claim: 'claim text', support: 'sup', locator: 'p.1', reliability: '高', tags: [] }],
  checklist: {},
  ...overrides,
});

function run() {
  const one = buildReviewDigest([paper()]);
  assert.equal(one.totalCount, 1);
  assert.equal(one.truncated, false);
  assert.equal(one.groups.length, 1);
  assert.equal(one.groups[0].tag, 'nlp');
  assert.equal(one.groups[0].papers[0].title, 'T');
  assert.match(one.groups[0].papers[0].evidence[0].claim, /claim text/);

  const many = buildReviewDigest(Array.from({ length: 41 }, (_, i) => paper({ id: `p${i}`, title: `T${i}`, tags: [] })));
  assert.equal(many.truncated, true);
  assert.equal(many.totalCount, 41);
  const kept = many.groups.flatMap((g) => g.papers);
  assert.equal(kept.length, 40);

  const longQ = 'x'.repeat(500);
  const d2 = buildReviewDigest([paper({ question: longQ })]);
  assert.equal(d2.groups[0].papers[0].question.length, 400);

  const evs = Array.from({ length: 10 }, (_, i) => ({ id: `e${i}`, claim: 'y'.repeat(300), support: '', locator: '', reliability: '中', tags: [] }));
  const d3 = buildReviewDigest([paper({ evidence: evs })]);
  const p3 = d3.groups[0].papers[0];
  assert.equal(p3.evidence.length, 8);
  assert.equal(p3.evidence[0].claim.length, 200);

  const d4 = buildReviewDigest([paper({ tags: [] })]);
  assert.equal(d4.groups[0].tag, '未分组');

  const empty = buildReviewDigest([]);
  assert.deepEqual(empty.groups, []);
  assert.equal(empty.totalCount, 0);

  console.log('paper digest tests passed');
}
run();
