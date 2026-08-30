'use strict';

const MAX_PAPERS = 40;
const FIELD_LIMIT = 400;
const CLAIM_LIMIT = 200;
const MAX_EVIDENCE = 8;

const UNGROUPED_TAG = '未分组';

const TEXT_FIELDS = [
  'title', 'authors', 'year', 'source', 'question', 'method',
  'dataset', 'findings', 'limitations', 'credibility',
];

const cut = (value, limit) => {
  const text = typeof value === 'string' ? value : value == null ? '' : String(value);
  return text.slice(0, limit);
};

const digestEvidence = (evidence) => {
  const items = Array.isArray(evidence) ? evidence : [];
  return items.slice(0, MAX_EVIDENCE).map((item) => ({
    ...item,
    claim: cut(item.claim, CLAIM_LIMIT),
    locator: cut(item.locator, CLAIM_LIMIT),
  }));
};

const digestPaper = (paper) => {
  const digested = { id: paper.id, status: paper.status };
  for (const field of TEXT_FIELDS) digested[field] = cut(paper[field], FIELD_LIMIT);
  digested.evidence = digestEvidence(paper.evidence);
  return digested;
};

function buildReviewDigest(papers) {
  const list = Array.isArray(papers) ? papers : [];
  const selected = list.slice(0, MAX_PAPERS);
  const groupsByTag = new Map();

  for (const paper of selected) {
    const digested = digestPaper(paper);
    const tags = Array.isArray(paper.tags)
      ? paper.tags.filter((tag) => typeof tag === 'string' && tag.length > 0)
      : [];
    const groupTags = tags.length > 0 ? tags : [UNGROUPED_TAG];
    for (const tag of groupTags) {
      let group = groupsByTag.get(tag);
      if (!group) {
        group = { tag, papers: [] };
        groupsByTag.set(tag, group);
      }
      group.papers.push(digested);
    }
  }

  const groups = [...groupsByTag.values()].sort((a, b) => a.tag.localeCompare(b.tag, 'zh'));

  return {
    totalCount: list.length,
    selectedCount: selected.length,
    truncated: list.length > MAX_PAPERS,
    groups,
  };
}

module.exports = { buildReviewDigest, MAX_PAPERS, FIELD_LIMIT, CLAIM_LIMIT, MAX_EVIDENCE };
