const fs = require('node:fs');
const path = require('node:path');

const base = path.join(__dirname, '..', 'test-fixtures', 'references');

function normalizeText(value) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
}

function firstValue(record, keys) {
  for (const key of keys) {
    const value = (record[key] || []).find((item) => item.trim());
    if (value) return value.trim();
  }
  return '';
}

function values(record, keys) {
  return keys.flatMap((key) => record[key] || []).map((item) => item.trim()).filter(Boolean);
}

function pickYear(value) {
  return (value.match(/(?:19|20)\d{2}/) || [''])[0] || '';
}

function uniqueTags(tags) {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function parseKeywordText(value) {
  return uniqueTags(value.split(/[;,，；、\n]/));
}

function inferBibTexOrigin(fields) {
  const archivePrefix = firstValue(fields, ['archiveprefix']).toLowerCase();
  const eprint = firstValue(fields, ['eprint']);
  if (archivePrefix.includes('arxiv') || /^\d{4}\.\d{4,5}/.test(eprint)) return 'arXiv';
  if (firstValue(fields, ['doi'])) return 'Crossref / DOI';
  return 'BibTeX';
}

function parseBibTex(content) {
  const entries = [...content.matchAll(/@\w+\s*\{[\s\S]*?(?=\n@\w+\s*\{|$)/g)].map((match) => match[0]);
  return entries.map((entry) => {
    const fields = {};
    for (const match of entry.matchAll(/(\w+)\s*=\s*(?:\{([\s\S]*?)\}|"([\s\S]*?)")\s*,?/g)) {
      const key = match[1].toLowerCase();
      fields[key] = [...(fields[key] || []), (match[2] || match[3] || '').replace(/\s+/g, ' ').trim()];
    }
    return {
      title: firstValue(fields, ['title']),
      authors: firstValue(fields, ['author']).replace(/\s+and\s+/gi, '; '),
      year: pickYear(firstValue(fields, ['year', 'date'])),
      source: firstValue(fields, ['journal', 'booktitle', 'publisher']),
      doi: firstValue(fields, ['doi']),
      url: firstValue(fields, ['url']),
      keywords: parseKeywordText(firstValue(fields, ['keywords', 'keyword'])),
      abstract: firstValue(fields, ['abstract']),
      origin: inferBibTexOrigin(fields),
      format: 'BibTeX',
    };
  }).filter((item) => item.title);
}

function inferRisOrigin(fields) {
  if (firstValue(fields, ['PMID', 'PM'])) return 'PubMed';
  if (firstValue(fields, ['DO'])) return 'RIS / DOI';
  return 'RIS';
}

function parseRis(content) {
  return normalizeText(content).split(/\nER\s*-\s*/i).map((block) => {
    const fields = {};
    for (const line of block.split('\n')) {
      const match = line.match(/^([A-Z0-9]{2})\s*-\s*(.*)$/i);
      if (!match) continue;
      const key = match[1].toUpperCase();
      fields[key] = [...(fields[key] || []), match[2].trim()];
    }
    const title = firstValue(fields, ['TI', 'T1', 'CT', 'BT']);
    return {
      title,
      authors: values(fields, ['AU', 'A1']).join('; '),
      year: pickYear(firstValue(fields, ['PY', 'Y1', 'DA'])),
      source: firstValue(fields, ['JO', 'JF', 'T2', 'JA']),
      doi: firstValue(fields, ['DO']),
      url: firstValue(fields, ['UR', 'L1', 'L2']),
      keywords: uniqueTags(values(fields, ['KW']).flatMap(parseKeywordText)),
      abstract: firstValue(fields, ['AB', 'N2']),
      origin: inferRisOrigin(fields),
      format: 'RIS',
    };
  }).filter((item) => item.title);
}

function parseNbib(content) {
  return normalizeText(content).split(/\n\s*\n+/).map((block) => {
    const fields = {};
    let currentKey = '';
    for (const rawLine of block.split('\n')) {
      const match = rawLine.match(/^([A-Z]{2,4})\s*-\s*(.*)$/);
      if (match) {
        currentKey = match[1].toUpperCase();
        fields[currentKey] = [...(fields[currentKey] || []), match[2].trim()];
      } else if (currentKey && rawLine.trim()) {
        const last = fields[currentKey].length - 1;
        fields[currentKey][last] = `${fields[currentKey][last]} ${rawLine.trim()}`.trim();
      }
    }
    const title = firstValue(fields, ['TI', 'TT']);
    return {
      title,
      authors: values(fields, ['AU', 'FAU']).join('; '),
      year: pickYear(firstValue(fields, ['DP', 'DEP', 'PHST'])),
      source: firstValue(fields, ['JT', 'TA', 'SO']),
      doi: (values(fields, ['AID', 'LID']).find((item) => /\bdoi\b/i.test(item)) || '').replace(/\s*\[doi\]\s*/i, '').trim(),
      url: firstValue(fields, ['PMC']) ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${firstValue(fields, ['PMC'])}/` : '',
      keywords: uniqueTags(values(fields, ['OT', 'MH']).flatMap(parseKeywordText)),
      abstract: values(fields, ['AB']).join(' '),
      origin: 'PubMed',
      format: 'NBIB',
    };
  }).filter((item) => item.title);
}

function splitDelimitedLine(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) {
      cells.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }
  cells.push(current.trim().replace(/^"|"$/g, ''));
  return cells;
}

function parseDelimitedReferences(content, delimiter) {
  const lines = normalizeText(content).split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];
  const headers = splitDelimitedLine(lines[0], delimiter).map((header) => header.trim().toLowerCase());
  const indexOf = (names) => headers.findIndex((header) => names.includes(header));
  const titleIndex = indexOf(['title', '题名', '篇名', '标题']);
  if (titleIndex < 0) return [];
  return lines.slice(1).map((line) => {
    const cells = splitDelimitedLine(line, delimiter);
    const cell = (names) => {
      const index = indexOf(names);
      return index >= 0 ? (cells[index] || '').trim() : '';
    };
    return {
      title: (cells[titleIndex] || '').trim(),
      authors: cell(['authors', 'author', '作者']).split(/[;,，；、]/).map((item) => item.trim()).filter(Boolean).join('; '),
      year: pickYear(cell(['year', 'date', 'publication year', '年份', '发表时间', '出版年'])),
      source: cell(['source', 'journal', 'publication', '刊名', '来源', '期刊']),
      doi: cell(['doi']),
      url: cell(['url', 'link', '链接', '网址']),
      keywords: parseKeywordText(cell(['keywords', 'keyword', '关键词', '关键字'])),
      abstract: cell(['abstract', '摘要']),
      origin: '自定义表格',
      format: delimiter === '\t' ? 'TSV' : 'CSV',
    };
  }).filter((item) => item.title);
}

function parseCnkiText(content) {
  const text = normalizeText(content);
  const blocks = text.split(/\n\s*\n+/).map((block) => block.trim()).filter(Boolean);
  const groups = blocks.length > 1 ? blocks : text.split(/(?=\n?\s*(?:题名|篇名|标题|Title)\s*[:：])/i).map((block) => block.trim()).filter(Boolean);
  return groups.map((block) => {
    const fields = {};
    let currentKey = '';
    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(/^([^:：]{1,24})\s*[:：]\s*(.*)$/);
      if (match) {
        currentKey = match[1].trim().toLowerCase();
        fields[currentKey] = [...(fields[currentKey] || []), match[2].trim()];
      } else if (currentKey) {
        const last = fields[currentKey].length - 1;
        fields[currentKey][last] = `${fields[currentKey][last]} ${line}`.trim();
      }
    }
    const title = firstValue(fields, ['题名', '篇名', '标题', 'title']);
    return {
      title,
      authors: values(fields, ['作者', 'author', 'authors']).flatMap((item) => item.split(/[;,，；、]/)).map((item) => item.trim()).filter(Boolean).join('; '),
      year: pickYear(firstValue(fields, ['发表时间', '出版年', '年份', '年', 'year', 'date'])),
      source: firstValue(fields, ['来源', '刊名', '期刊', '出版物', 'journal', 'source']),
      doi: firstValue(fields, ['doi']).replace(/^doi\s*[:：]?\s*/i, ''),
      url: firstValue(fields, ['链接', '网址', 'url']),
      keywords: uniqueTags(values(fields, ['关键词', '关键字', 'keyword', 'keywords']).flatMap(parseKeywordText)),
      abstract: firstValue(fields, ['摘要', 'abstract']),
      origin: 'CNKI',
      format: 'CNKI文本',
    };
  }).filter((item) => item.title);
}

function looksLikeHtml(content, filePath) {
  const lowerPath = filePath.toLowerCase();
  const sample = content.slice(0, 500).toLowerCase();
  return lowerPath.endsWith('.html') || lowerPath.endsWith('.htm') || /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(sample);
}

function parseReferences(content, filePath = '') {
  const text = normalizeText(content);
  const lowerPath = filePath.toLowerCase();
  if (looksLikeHtml(text, lowerPath)) throw new Error('HTML rejected');
  if (lowerPath.endsWith('.bib') || /^\s*@\w+\s*\{/m.test(text)) return parseBibTex(text);
  if (lowerPath.endsWith('.nbib') || /^PMID\s*-/m.test(text)) return parseNbib(text);
  if (lowerPath.endsWith('.ris') || lowerPath.endsWith('.enw') || /^TY\s*-\s*/m.test(text)) return parseRis(text);
  if (lowerPath.endsWith('.csv')) return parseDelimitedReferences(text, ',');
  if (lowerPath.endsWith('.tsv')) return parseDelimitedReferences(text, '\t');
  const cnki = parseCnkiText(text);
  if (cnki.length > 0) return cnki;
  const tabular = text.includes('\t') ? parseDelimitedReferences(text, '\t') : parseDelimitedReferences(text, ',');
  if (tabular.length > 0) return tabular;
  throw new Error('unknown');
}

const files = ['cnki-sample.txt', 'bibtex-sample.bib', 'ris-sample.ris', 'pubmed-sample.nbib', 'csv-sample.csv'];
const refs = files.flatMap((file) => parseReferences(fs.readFileSync(path.join(base, file), 'utf8'), file));
console.log(refs.map((ref) => `${ref.format}:${ref.origin}:${ref.title}`).join('\n'));
if (refs.length !== 8) throw new Error(`expected 8 refs, got ${refs.length}`);

let rejected = false;
try {
  parseReferences(fs.readFileSync(path.join(base, 'not-a-reference.html'), 'utf8'), 'not-a-reference.html');
} catch {
  rejected = true;
}
if (!rejected) throw new Error('HTML was not rejected');

console.log('general import fixture test passed');
