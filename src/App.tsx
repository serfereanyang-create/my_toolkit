import {
  App as AntApp,
  ConfigProvider,
  Layout,
  message,
  Modal,
  theme,
} from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { AccountDrawer } from './components/paper/AccountDrawer';
import type { AuthMode } from './components/paper/AccountDrawer';
import { AiSettings } from './components/paper/AiSettings';
import { AppHeader } from './components/paper/AppHeader';
import { DisplaySettings } from './components/paper/DisplaySettings';
import type { AppFont, ContrastLevel } from './components/paper/DisplaySettings';
import { EmptyWorkspace } from './components/paper/EmptyWorkspace';
import { PaperLibrary } from './components/paper/PaperLibrary';
import { PaperWorkspace } from './components/paper/PaperWorkspace';
import { QualityDrawer, DEFAULT_CHECKLIST_ITEMS } from './components/paper/QualityDrawer';
import { ReviewDrawer } from './components/paper/ReviewDrawer';
import { buildLiteratureMatrix } from './lib/literatureMatrix';
import type { AiReviewApi } from './lib/reviewDigest';
import {
  getThemeTokens,
  nextActiveDrawer,
  nextSaveStatus,
  resolveSessionStatus,
} from './lib/uiState';
import type { ActiveDrawer, AppTheme, SaveStatus } from './lib/uiState';
import type {
  AccountProfile,
  AuthResult,
  AuthUser,
  EditorSection,
  Evidence,
  Paper,
  PaperStatus,
} from './types/paperApp';

type ImportedReference = {
  title: string;
  authors: string;
  year: string;
  source: string;
  doi: string;
  url: string;
  keywords: string[];
  abstract: string;
  origin: string;
  format: string;
};

type DesktopCommand = 'new-paper' | 'import-library' | 'import-references' | 'export-library' | 'export-markdown';

type DesktopApi = {
  saveMarkdown: (defaultName: string, content: string) => Promise<{ canceled: boolean; filePath?: string }>;
  exportLibrary: (defaultName: string, content: string) => Promise<{ canceled: boolean; filePath?: string }>;
  importLibrary: () => Promise<{ canceled: boolean; filePath?: string; content?: string }>;
  importReferences: () => Promise<{ canceled: boolean; filePath?: string; content?: string }>;
  onCommand: (callback: (command: DesktopCommand) => void) => () => void;
  auth: {
    register: (input: {
      username: string;
      email?: string;
      password: string;
      confirmPassword: string;
    }) => Promise<AuthResult>;
    login: (input: { account: string; password: string }) => Promise<AuthResult>;
    logout: () => Promise<{ ok: true }>;
    getSession: () => Promise<{ user: AuthUser } | null>;
    updateProfile: (patch: Partial<AccountProfile>) => Promise<AuthResult>;
    changePassword: (input: {
      oldPassword: string;
      newPassword: string;
      confirmPassword: string;
    }) => Promise<{ ok: true } | { ok: false; error: string }>;
  };
  library: {
    load: () => Promise<Paper[]>;
    save: (papers: Paper[]) => Promise<{ ok: true }>;
  };
  ai: AiReviewApi;
};

declare global {
  interface Window {
    desktopApi?: DesktopApi;
  }
}

const statusOptions: PaperStatus[] = ['未读', '粗读', '精读', '已摘录', '待复核'];
const checklistItems = [...DEFAULT_CHECKLIST_ITEMS];

const storageKey = 'science-paper-assistant:v1';
const themeStorageKey = 'science-paper-assistant:theme';
const textContrastStorageKey = 'science-paper-assistant:text-contrast';
const uiContrastStorageKey = 'science-paper-assistant:ui-contrast';
const fontStorageKey = 'science-paper-assistant:font';
const accountStorageKey = 'science-paper-assistant:account';
const legacyMigrationKey = (userId: string) => `science-paper-assistant:legacy-migration:${userId}`;

const emptyAccount = (): AccountProfile => ({
  displayName: '',
  institution: '',
  researchField: '',
  email: '',
  notes: '',
});

function loadAccount(): AccountProfile {
  try {
    const raw = localStorage.getItem(accountStorageKey);
    if (!raw) return emptyAccount();
    const parsed = JSON.parse(raw) as Partial<AccountProfile>;
    return {
      displayName: String(parsed.displayName ?? ''),
      institution: String(parsed.institution ?? ''),
      researchField: String(parsed.researchField ?? ''),
      email: String(parsed.email ?? ''),
      notes: String(parsed.notes ?? ''),
    };
  } catch {
    return emptyAccount();
  }
}

function profileFromUser(user: AuthUser): AccountProfile {
  return {
    displayName: user.displayName,
    institution: user.institution,
    researchField: user.researchField,
    email: user.email,
    notes: user.notes,
  };
}

const fontStacks: Record<AppFont, string> = {
  system: '"Segoe UI", "PingFang SC", "Microsoft YaHei", Inter, Arial, sans-serif',
  sans: '"Microsoft YaHei", "PingFang SC", "Noto Sans SC", "Segoe UI", sans-serif',
  serif: '"SimSun", "Songti SC", "Noto Serif SC", "Times New Roman", serif',
  kai: '"KaiTi", "STKaiti", "Kaiti SC", "Noto Serif SC", serif',
  fangsong: '"FangSong", "STFangsong", "仿宋", "Songti SC", serif',
  mono: 'Consolas, "Cascadia Mono", "Sarasa Mono SC", "Microsoft YaHei Mono", monospace',
};

function loadTheme(): AppTheme {
  const saved = localStorage.getItem(themeStorageKey);
  if (saved === 'cool' || saved === 'paper' || saved === 'dark') return saved;
  return 'paper';
}

function loadContrast(key: string, fallback: ContrastLevel = 'normal'): ContrastLevel {
  const saved = localStorage.getItem(key);
  if (saved === 'soft' || saved === 'normal' || saved === 'high') return saved;
  return fallback;
}

function loadFont(): AppFont {
  const saved = localStorage.getItem(fontStorageKey);
  if (saved === 'system' || saved === 'sans' || saved === 'serif' || saved === 'kai' || saved === 'fangsong' || saved === 'mono') {
    return saved;
  }
  return 'system';
}

const emptyChecklist = () => Object.fromEntries(checklistItems.map((item) => [item, false]));

const samplePapers: Paper[] = [
  {
    id: 'paper-sample-1',
    title: 'Sample: Structured Reading Notes for Reproducible Research',
    authors: 'Lin Q.; Alvarez M.',
    year: '2024',
    source: 'Journal of Research Workflows',
    doi: '10.0000/sample.2024.001',
    url: 'https://example.org/sample-reading-notes',
    status: '精读',
    tags: ['reproducibility', 'reading-note'],
    question: '结构化阅读卡片能否减少文献综述中的证据遗漏。',
    method: '对 42 篇方法学论文进行双人标注，并比较自由笔记与结构化笔记。',
    dataset: 'Sample dataset; 42 篇虚构示例论文。',
    findings: '结构化字段能提升结论、方法和局限性的检索效率。',
    limitations: '样本规模较小，且只覆盖方法学类论文。',
    credibility: '示例数据，仅用于展示字段组织方式。',
    evidence: [
      {
        id: 'ev-1',
        claim: '结构化笔记提升复查效率',
        support: '参与者在二次检索任务中平均减少 23% 查找时间。',
        locator: 'p. 7, Table 2',
        reliability: '中',
        tags: ['workflow', 'evidence'],
      },
    ],
    checklist: {
      ...emptyChecklist(),
      研究问题明确: true,
      方法可复现: true,
      局限性已记录: true,
      引用字段完整: true,
    },
  },
  {
    id: 'paper-sample-2',
    title: 'Sample: Citation Metadata Audits in Systematic Reviews',
    authors: 'Nakamura S.; Chen R.',
    year: '2023',
    source: 'Open Review Methods',
    doi: '',
    url: '',
    status: '待复核',
    tags: ['citation', 'audit'],
    question: '引用元数据缺失会怎样影响系统综述的复核成本。',
    method: '抽样检查参考文献条目中的 DOI、年份、作者与来源字段。',
    dataset: 'Sample reference list; 180 条虚构引用。',
    findings: '缺失 DOI 与来源字段会显著增加人工查证时间。',
    limitations: '未覆盖非英文文献和预印本版本差异。',
    credibility: '示例数据，适合作为引用检查模块演示。',
    evidence: [],
    checklist: {
      ...emptyChecklist(),
      研究问题明确: true,
      统计或评估指标清楚: true,
      局限性已记录: true,
    },
  },
];

function makeId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function loadPapers() {
  const stored = localStorage.getItem(storageKey);
  if (!stored) return samplePapers;

  try {
    return JSON.parse(stored) as Paper[];
  } catch {
    return samplePapers;
  }
}

function createPaper(): Paper {
  return {
    id: makeId('paper'),
    title: '未命名论文',
    authors: '',
    year: '',
    source: '',
    doi: '',
    url: '',
    status: '未读',
    tags: [],
    question: '',
    method: '',
    dataset: '',
    findings: '',
    limitations: '',
    credibility: '',
    evidence: [],
    checklist: emptyChecklist(),
  };
}

function inspectCitation(paper: Paper, papers: Paper[]) {
  const issues: string[] = [];
  const prefix = paper.title || '未命名论文';
  if (!paper.authors.trim()) issues.push(`${prefix}: 缺少作者`);
  if (!paper.year.trim()) issues.push(`${prefix}: 缺少年份`);
  if (!paper.source.trim()) issues.push(`${prefix}: 缺少来源`);
  if (!paper.doi.trim() && !paper.url.trim()) issues.push(`${prefix}: DOI 和 URL 至少补一个`);
  if (paper.doi.trim()) {
    const duplicates = papers.filter((item) => item.id !== paper.id && item.doi.trim().toLowerCase() === paper.doi.trim().toLowerCase());
    if (duplicates.length > 0) issues.push(`${prefix}: DOI 与其他卡片重复`);
  }
  return issues;
}

function buildMarkdown(paper: Paper) {
  const evidence = paper.evidence.length
    ? paper.evidence.map((item) => `- ${item.claim || '未填写主张'}\n  - 证据：${item.support || '待补'}\n  - 位置：${item.locator || '待补'}\n  - 可靠性：${item.reliability}\n  - 标签：${item.tags.join(', ') || '无'}`).join('\n')
    : '- 暂无证据条目';

  const checklist = checklistItems.map((item) => `- [${paper.checklist[item] ? 'x' : ' '}] ${item}`).join('\n');

  return `# ${paper.title || '未命名论文'}\n\n## 基本信息\n- 作者：${paper.authors || '待补'}\n- 年份：${paper.year || '待补'}\n- 来源：${paper.source || '待补'}\n- DOI：${paper.doi || '待补'}\n- URL：${paper.url || '待补'}\n- 状态：${paper.status}\n- 标签：${paper.tags.join(', ') || '无'}\n\n## 结构化阅读卡片\n### 研究问题\n${paper.question || '待补'}\n\n### 方法\n${paper.method || '待补'}\n\n### 数据集 / 样本\n${paper.dataset || '待补'}\n\n### 关键发现\n${paper.findings || '待补'}\n\n### 局限性\n${paper.limitations || '待补'}\n\n### 可信度备注\n${paper.credibility || '待补'}\n\n## 证据表\n${evidence}\n\n## 材料自查\n${checklist}\n`;
}

function isPaperLibrary(value: unknown): value is Paper[] {
  return Array.isArray(value) && value.every((paper) => {
    if (!paper || typeof paper !== 'object') return false;
    const item = paper as Paper;
    return typeof item.id === 'string'
      && typeof item.title === 'string'
      && statusOptions.includes(item.status)
      && Array.isArray(item.tags)
      && Array.isArray(item.evidence)
      && item.checklist
      && typeof item.checklist === 'object';
  });
}

function normalizeText(value: string) {
  return value.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');
}

function firstValue(record: Record<string, string[]>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]?.find((item) => item.trim());
    if (value) return value.trim();
  }
  return '';
}

function values(record: Record<string, string[]>, keys: string[]) {
  return keys.flatMap((key) => record[key] ?? []).map((item) => item.trim()).filter(Boolean);
}

function pickYear(value: string) {
  return value.match(/(?:19|20)\d{2}/)?.[0] ?? '';
}

function uniqueTags(tags: string[]) {
  return Array.from(new Set(tags.map((tag) => tag.trim()).filter(Boolean)));
}

function parseKeywordText(value: string) {
  return uniqueTags(value.split(/[;,，；、\n]/));
}

function makeImportedPaper(reference: ImportedReference): Paper {
  const hasDoi = Boolean(reference.doi.trim());
  const matchNote = hasDoi
    ? '匹配来源：DOI（强匹配）。'
    : '匹配来源：题名+年份（弱匹配，可能有误差，请人工复核并重新索引）。';
  const abstractNote = reference.abstract ? `导入摘要：${reference.abstract}` : '';

  return {
    id: makeId('paper'),
    title: reference.title || '未命名文献',
    authors: reference.authors,
    year: reference.year,
    source: reference.source,
    doi: reference.doi,
    url: reference.url,
    status: '未读',
    tags: uniqueTags([reference.origin, reference.format, hasDoi ? 'DOI强匹配' : '题名年份弱匹配', ...reference.keywords]),
    question: '',
    method: '',
    dataset: '',
    findings: '',
    limitations: '',
    credibility: [`由${reference.origin}导入，格式：${reference.format}。`, matchNote, abstractNote].filter(Boolean).join('\n'),
    evidence: [],
    checklist: emptyChecklist(),
  };
}

function inferBibTexOrigin(fields: Record<string, string[]>) {
  const archivePrefix = firstValue(fields, ['archiveprefix']).toLowerCase();
  const eprint = firstValue(fields, ['eprint']);
  if (archivePrefix.includes('arxiv') || /^\d{4}\.\d{4,5}/.test(eprint)) return 'arXiv';
  if (firstValue(fields, ['doi'])) return 'Crossref / DOI';
  return 'BibTeX';
}

function parseBibTex(content: string): ImportedReference[] {
  const entries = [...content.matchAll(/@\w+\s*\{[\s\S]*?(?=\n@\w+\s*\{|$)/g)].map((match) => match[0]);

  return entries.map((entry) => {
    const fields: Record<string, string[]> = {};
    for (const match of entry.matchAll(/(\w+)\s*=\s*(?:\{([\s\S]*?)\}|"([\s\S]*?)")\s*,?/g)) {
      const key = match[1].toLowerCase();
      fields[key] = [...(fields[key] ?? []), (match[2] ?? match[3] ?? '').replace(/\s+/g, ' ').trim()];
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

function inferRisOrigin(fields: Record<string, string[]>) {
  if (firstValue(fields, ['PMID', 'PM'])) return 'PubMed';
  if (firstValue(fields, ['DO'])) return 'RIS / DOI';
  return 'RIS';
}

function parseRis(content: string): ImportedReference[] {
  return normalizeText(content).split(/\nER\s*-\s*/i).map((block) => {
    const fields: Record<string, string[]> = {};
    for (const line of block.split('\n')) {
      const match = line.match(/^([A-Z0-9]{2})\s*-\s*(.*)$/i);
      if (!match) continue;
      const key = match[1].toUpperCase();
      fields[key] = [...(fields[key] ?? []), match[2].trim()];
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

function parseNbib(content: string): ImportedReference[] {
  return normalizeText(content).split(/\n\s*\n+/).map((block) => {
    const fields: Record<string, string[]> = {};
    let currentKey = '';

    for (const rawLine of block.split('\n')) {
      const match = rawLine.match(/^([A-Z]{2,4})\s*-\s*(.*)$/);
      if (match) {
        currentKey = match[1].toUpperCase();
        fields[currentKey] = [...(fields[currentKey] ?? []), match[2].trim()];
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
      doi: values(fields, ['AID', 'LID']).find((item) => /\bdoi\b/i.test(item))?.replace(/\s*\[doi\]\s*/i, '').trim() ?? '',
      url: firstValue(fields, ['PMC']) ? `https://www.ncbi.nlm.nih.gov/pmc/articles/${firstValue(fields, ['PMC'])}/` : '',
      keywords: uniqueTags(values(fields, ['OT', 'MH']).flatMap(parseKeywordText)),
      abstract: values(fields, ['AB']).join(' '),
      origin: 'PubMed',
      format: 'NBIB',
    };
  }).filter((item) => item.title);
}

function splitDelimitedLine(line: string, delimiter: string) {
  const cells: string[] = [];
  let current = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current.trim().replace(/^"|"$/g, ''));
      current = '';
    } else {
      current += char;
    }
  }

  cells.push(current.trim().replace(/^"|"$/g, ''));
  return cells;
}

function parseDelimitedReferences(content: string, delimiter: ',' | '\t'): ImportedReference[] {
  const lines = normalizeText(content).split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return [];

  const headers = splitDelimitedLine(lines[0], delimiter).map((header) => header.trim().toLowerCase());
  const indexOf = (names: string[]) => headers.findIndex((header) => names.includes(header));
  const titleIndex = indexOf(['title', '题名', '篇名', '标题']);
  if (titleIndex < 0) return [];

  return lines.slice(1).map((line) => {
    const cells = splitDelimitedLine(line, delimiter);
    const cell = (names: string[]) => {
      const index = indexOf(names);
      return index >= 0 ? cells[index]?.trim() ?? '' : '';
    };

    return {
      title: cells[titleIndex]?.trim() ?? '',
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

function parseCnkiText(content: string): ImportedReference[] {
  const text = normalizeText(content);
  const blocks = text
    .split(/\n\s*\n+/)
    .map((block) => block.trim())
    .filter(Boolean);
  const groups = blocks.length > 1 ? blocks : text.split(/(?=\n?\s*(?:题名|篇名|标题|Title)\s*[:：])/i).map((block) => block.trim()).filter(Boolean);

  return groups.map((block) => {
    const fields: Record<string, string[]> = {};
    let currentKey = '';

    for (const rawLine of block.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(/^([^:：]{1,24})\s*[:：]\s*(.*)$/);
      if (match) {
        currentKey = match[1].trim().toLowerCase();
        fields[currentKey] = [...(fields[currentKey] ?? []), match[2].trim()];
      } else if (currentKey) {
        const last = fields[currentKey].length - 1;
        fields[currentKey][last] = `${fields[currentKey][last]} ${line}`.trim();
      }
    }

    const title = firstValue(fields, ['题名', '篇名', '标题', 'title']);
    const keywords = uniqueTags(values(fields, ['关键词', '关键字', 'keyword', 'keywords']).flatMap(parseKeywordText));
    return {
      title,
      authors: values(fields, ['作者', 'author', 'authors']).flatMap((item) => item.split(/[;,，；、]/)).map((item) => item.trim()).filter(Boolean).join('; '),
      year: pickYear(firstValue(fields, ['发表时间', '出版年', '年份', '年', 'year', 'date'])),
      source: firstValue(fields, ['来源', '刊名', '期刊', '出版物', 'journal', 'source']),
      doi: firstValue(fields, ['doi']).replace(/^doi\s*[:：]?\s*/i, ''),
      url: firstValue(fields, ['链接', '网址', 'url']),
      keywords,
      abstract: firstValue(fields, ['摘要', 'abstract']),
      origin: 'CNKI',
      format: 'CNKI文本',
    };
  }).filter((item) => item.title);
}

function looksLikeHtml(content: string, filePath: string) {
  const lowerPath = filePath.toLowerCase();
  const sample = content.slice(0, 500).toLowerCase();
  return lowerPath.endsWith('.html') || lowerPath.endsWith('.htm') || /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(sample);
}

function parseReferences(content: string, filePath = '') {
  const text = normalizeText(content);
  const lowerPath = filePath.toLowerCase();
  if (looksLikeHtml(text, lowerPath)) {
    throw new Error('HTML 页面不是标准引用文件。请从网站下载 BibTeX、RIS、NBIB、CSV 或 TXT 引用格式后再导入。');
  }
  if (lowerPath.endsWith('.bib') || /^\s*@\w+\s*\{/m.test(text)) return parseBibTex(text);
  if (lowerPath.endsWith('.nbib') || /^PMID\s*-/m.test(text)) return parseNbib(text);
  if (lowerPath.endsWith('.ris') || lowerPath.endsWith('.enw') || /^TY\s*-\s*/m.test(text)) return parseRis(text);
  if (lowerPath.endsWith('.csv')) return parseDelimitedReferences(text, ',');
  if (lowerPath.endsWith('.tsv')) return parseDelimitedReferences(text, '\t');

  const cnki = parseCnkiText(text);
  if (cnki.length > 0) return cnki;

  const tabular = text.includes('\t') ? parseDelimitedReferences(text, '\t') : parseDelimitedReferences(text, ',');
  if (tabular.length > 0) return tabular;

  throw new Error('未识别到标准引用格式。请下载 BibTeX、RIS、PubMed NBIB、CNKI 文本或 CSV/TSV；仍无法导入时请使用自定义表格列名：title/authors/year/source/doi/url/keywords/abstract。');
}

function doiKey(paper: Pick<Paper, 'doi'>) {
  return paper.doi.trim().toLowerCase();
}

function titleYearKey(paper: Pick<Paper, 'title' | 'year'>) {
  const title = paper.title.trim().replace(/\s+/g, ' ').toLowerCase();
  const year = paper.year.trim();
  return title && year ? `${title}|${year}` : '';
}

function matchImportedPaper(paper: Paper, existingDoiKeys: Set<string>, existingTitleYearKeys: Set<string>) {
  const doi = doiKey(paper);
  if (doi && existingDoiKeys.has(doi)) return 'DOI强匹配';

  const titleYear = titleYearKey(paper);
  if (titleYear && existingTitleYearKeys.has(titleYear)) return '题名+年份弱匹配';

  return '';
}

function App() {
  const [papers, setPapers] = useState<Paper[]>(() => (window.desktopApi?.auth ? [] : loadPapers()));
  const [selectedId, setSelectedId] = useState(papers[0]?.id ?? '');
  const [query, setQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<'全部' | PaperStatus>('全部');
  const [tagFilter, setTagFilter] = useState('全部');
  const [appTheme, setAppTheme] = useState<AppTheme>(loadTheme);
  const [textContrast, setTextContrast] = useState<ContrastLevel>(() => loadContrast(textContrastStorageKey));
  const [uiContrast, setUiContrast] = useState<ContrastLevel>(() => loadContrast(uiContrastStorageKey));
  const [appFont, setAppFont] = useState<AppFont>(loadFont);
  const [editorSection, setEditorSection] = useState<EditorSection>('overview');
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [activeDrawer, setActiveDrawer] = useState<ActiveDrawer>(null);
  const [libraryCollapsed, setLibraryCollapsed] = useState(false);
  const [sessionLoading, setSessionLoading] = useState(Boolean(window.desktopApi?.auth));
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [currentUser, setCurrentUser] = useState<AuthUser | null>(null);
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [authBusy, setAuthBusy] = useState(false);
  const [authError, setAuthError] = useState('');
  const [loginForm, setLoginForm] = useState({ account: '', password: '' });
  const [registerForm, setRegisterForm] = useState({
    username: '',
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [passwordForm, setPasswordForm] = useState({
    oldPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [accountDraft, setAccountDraft] = useState<AccountProfile>(loadAccount);

  const selected = papers.find((paper) => paper.id === selectedId) ?? papers[0] ?? null;
  const themeTokens = getThemeTokens(appTheme);
  const activeFontFamily = fontStacks[appFont];
  const accountInitial = currentUser
    ? (currentUser.displayName.trim() || currentUser.username || '研').slice(0, 1).toUpperCase()
    : undefined;
  // Browser/local dev has no desktop auth API; keep localStorage papers usable.
  const hasDesktopAuth = Boolean(window.desktopApi?.auth);
  const sessionStatus = hasDesktopAuth
    ? resolveSessionStatus({ loading: sessionLoading, user: currentUser })
    : 'authenticated';
  const showEmptyWorkspace = sessionStatus !== 'authenticated' || !selected;

  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-theme', appTheme);
    root.setAttribute('data-text-contrast', textContrast);
    root.setAttribute('data-ui-contrast', uiContrast);
    root.setAttribute('data-font', appFont);
    root.style.setProperty('--app-font', activeFontFamily);
    localStorage.setItem(themeStorageKey, appTheme);
    localStorage.setItem(textContrastStorageKey, textContrast);
    localStorage.setItem(uiContrastStorageKey, uiContrast);
    localStorage.setItem(fontStorageKey, appFont);
  }, [appTheme, textContrast, uiContrast, appFont, activeFontFamily]);

  useEffect(() => {
    let cancelled = false;

    async function boot() {
      if (!window.desktopApi?.auth) {
        setSessionLoading(false);
        return;
      }
      try {
        const session = await window.desktopApi.auth.getSession();
        if (cancelled) return;
        if (!session?.user) {
          setCurrentUser(null);
          setPapers([]);
          setSelectedId('');
          return;
        }

        setCurrentUser(session.user);
        setAccountDraft(profileFromUser(session.user));
        const remote = await window.desktopApi.library.load();
        if (!cancelled) {
          setPapers(remote);
          setSelectedId(remote[0]?.id ?? '');
        }
      } catch {
        if (!cancelled) message.error('账户会话加载失败，请重试');
      } finally {
        if (!cancelled) setSessionLoading(false);
      }
    }

    void boot();
    return () => {
      cancelled = true;
    };
  }, []);

  function openQualityDrawer() {
    setSettingsOpen(false);
    setActiveDrawer((prev) => nextActiveDrawer(prev, 'quality'));
  }

  function openAccountDrawer() {
    setSettingsOpen(false);
    setActiveDrawer((prev) => {
      const next = nextActiveDrawer(prev, 'account');
      if (next === 'account') {
        if (currentUser) setAccountDraft(profileFromUser(currentUser));
        setAuthError('');
      }
      return next;
    });
  }

  function openReviewDrawer() {
    setSettingsOpen(false);
    setActiveDrawer((prev) => nextActiveDrawer(prev, 'review'));
  }

  function closeDrawer() {
    setActiveDrawer(null);
  }

  function openSettingsPanel(open: boolean) {
    if (open) setActiveDrawer(null);
    setSettingsOpen(open);
  }

  function updateAccountDraft<K extends keyof AccountProfile>(key: K, value: AccountProfile[K]) {
    setAccountDraft((prev) => ({ ...prev, [key]: value }));
  }

  async function maybeOfferLegacyImport(user: AuthUser) {
    if (!window.desktopApi?.library || !user) return;
    const migrationKey = legacyMigrationKey(user.id);
    if (localStorage.getItem(migrationKey) === 'done') return;
    const existing = await window.desktopApi.library.load();
    if (existing.length > 0) {
      localStorage.setItem(migrationKey, 'done');
      return;
    }

    const raw = localStorage.getItem(storageKey);
    if (!raw) return;

    let legacy: Paper[];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!isPaperLibrary(parsed) || parsed.length === 0) return;
      legacy = parsed;
    } catch {
      return;
    }

    Modal.confirm({
      title: '发现旧版本地论文库',
      content: `检测到 ${legacy.length} 篇旧数据。是否导入到当前账户？不会自动删除旧数据。`,
      okText: '导入到当前账户',
      cancelText: '暂不导入',
      onOk: async () => {
        await window.desktopApi!.library.save(legacy);
        localStorage.setItem(legacyMigrationKey(user.id), 'done');
        setPapers(legacy);
        setSelectedId(legacy[0]?.id ?? '');
        message.success('旧论文库已导入当前账户');
      },
      onCancel: () => {
        localStorage.setItem(legacyMigrationKey(user.id), 'done');
      },
    });
  }

  async function handleRegister() {
    if (!window.desktopApi?.auth) {
      message.error('账户系统仅在桌面端可用');
      return;
    }

    setAuthBusy(true);
    setAuthError('');
    try {
      const result = await window.desktopApi.auth.register(registerForm);
      if (!result.ok) {
        setAuthError(result.error);
        return;
      }

      const legacyProfile = loadAccount();
      const profilePatch = Object.values(legacyProfile).some((value) => value.trim()) ? legacyProfile : null;
      let registeredUser = result.user;
      if (profilePatch) {
        const profileResult = await window.desktopApi.auth.updateProfile(profilePatch);
        if (profileResult.ok) {
          registeredUser = profileResult.user;
          localStorage.removeItem(accountStorageKey);
        }
      }

      setCurrentUser(registeredUser);
      setAccountDraft(profileFromUser(registeredUser));
      setPapers([]);
      setSelectedId('');
      setRegisterForm({ username: '', email: '', password: '', confirmPassword: '' });
      message.success('注册成功');
      await maybeOfferLegacyImport(registeredUser);
    } catch {
      setAuthError('注册失败，请重试');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogin() {
    if (!window.desktopApi?.auth) {
      message.error('账户系统仅在桌面端可用');
      return;
    }

    setAuthBusy(true);
    setAuthError('');
    try {
      const result = await window.desktopApi.auth.login(loginForm);
      if (!result.ok) {
        setAuthError(result.error);
        setLoginForm((prev) => ({ ...prev, password: '' }));
        return;
      }

      setCurrentUser(result.user);
      setAccountDraft(profileFromUser(result.user));
      setLoginForm({ account: '', password: '' });
      const remote = await window.desktopApi.library.load();
      setPapers(remote);
      setSelectedId(remote[0]?.id ?? '');
      message.success('登录成功');
      await maybeOfferLegacyImport(result.user);
    } catch {
      setAuthError('登录失败，请重试');
    } finally {
      setAuthBusy(false);
    }
  }

  async function handleLogout() {
    if (!window.desktopApi?.auth) return;
    await window.desktopApi.auth.logout();
    setCurrentUser(null);
    setAccountDraft(emptyAccount());
    setPapers([]);
    setSelectedId('');
    setPasswordForm({ oldPassword: '', newPassword: '', confirmPassword: '' });
    setAuthMode('login');
    setActiveDrawer(null);
    message.success('已退出登录');
  }

  async function saveAccount() {
    if (!window.desktopApi?.auth || !currentUser) return;
    const result = await window.desktopApi.auth.updateProfile({
      displayName: accountDraft.displayName,
      institution: accountDraft.institution,
      researchField: accountDraft.researchField,
      email: accountDraft.email,
      notes: accountDraft.notes,
    });
    if (!result.ok) {
      message.error(result.error);
      return;
    }

    setCurrentUser(result.user);
    setAccountDraft(profileFromUser(result.user));
    localStorage.removeItem(accountStorageKey);
    message.success('账户资料已保存');
  }

  async function handleChangePassword() {
    if (!window.desktopApi?.auth || !currentUser) return;
    setAuthBusy(true);
    try {
      const result = await window.desktopApi.auth.changePassword(passwordForm);
      if (!result.ok) {
        message.error(result.error);
        return;
      }
      setPasswordForm({ oldPassword: '', newPassword: '', confirmPassword: '' });
      message.success('密码已修改');
    } finally {
      setAuthBusy(false);
    }
  }

  function requireDesktopLogin() {
    if (window.desktopApi?.auth && !currentUser) {
      message.warning('请先登录账户');
      setActiveDrawer('account');
      return false;
    }
    return true;
  }

  const allTags = useMemo(() => {
    const tags = new Set<string>();
    papers.forEach((paper) => paper.tags.forEach((tag) => tags.add(tag)));
    return ['全部', ...Array.from(tags).sort()];
  }, [papers]);

  const filteredPapers = useMemo(() => {
    const text = query.trim().toLowerCase();
    return papers.filter((paper) => {
      const matchesText = !text || [paper.title, paper.authors, paper.source, paper.tags.join(' ')].join(' ').toLowerCase().includes(text);
      const matchesStatus = statusFilter === '全部' || paper.status === statusFilter;
      const matchesTag = tagFilter === '全部' || paper.tags.includes(tagFilter);
      return matchesText && matchesStatus && matchesTag;
    });
  }, [papers, query, statusFilter, tagFilter]);

  const citationIssues = useMemo(() => papers.flatMap((paper) => inspectCitation(paper, papers)), [papers]);
  const selectedIssues = selected ? inspectCitation(selected, papers) : [];
  const evidenceCount = papers.reduce((sum, paper) => sum + paper.evidence.length, 0);

  async function persist(next: Paper[]) {
    if (!requireDesktopLogin()) return;
    setPapers(next);
    if (window.desktopApi?.library && currentUser) {
      setSaveStatus((current) => nextSaveStatus(current, 'start'));
      try {
        await window.desktopApi.library.save(next);
        setSaveStatus((current) => nextSaveStatus(current, 'success'));
      } catch {
        setSaveStatus((current) => nextSaveStatus(current, 'error'));
        message.error('论文库保存失败，请重试');
      }
      return;
    }
    localStorage.setItem(storageKey, JSON.stringify(next));
    setSaveStatus('saved');
  }

  function retrySave() {
    if (!requireDesktopLogin()) return;
    void persist(papers);
  }

  function updateSelected(patch: Partial<Paper>) {
    if (!selected || !requireDesktopLogin()) return;
    persist(papers.map((paper) => (paper.id === selected.id ? { ...paper, ...patch } : paper)));
  }

  function addPaper() {
    if (!requireDesktopLogin()) return;
    const paper = createPaper();
    persist([paper, ...papers]);
    setSelectedId(paper.id);
    message.success('已新建论文卡片');
  }

  function resetSamples() {
    if (!requireDesktopLogin()) return;
    persist(samplePapers);
    setSelectedId(samplePapers[0].id);
    message.success('示例数据已恢复');
  }

  function deleteSelected() {
    if (!selected || papers.length === 1 || !requireDesktopLogin()) return;
    const next = papers.filter((paper) => paper.id !== selected.id);
    persist(next);
    setSelectedId(next[0].id);
    message.success('论文卡片已删除');
  }

  function addEvidence() {
    if (!selected) return;
    updateSelected({
      evidence: [
        ...selected.evidence,
        {
          id: makeId('ev'),
          claim: '',
          support: '',
          locator: '',
          reliability: '中',
          tags: [],
        },
      ],
    });
  }

  function updateEvidence(id: string, patch: Partial<Evidence>) {
    if (!selected) return;
    updateSelected({ evidence: selected.evidence.map((item) => (item.id === id ? { ...item, ...patch } : item)) });
  }

  function removeEvidence(id: string) {
    if (!selected) return;
    updateSelected({ evidence: selected.evidence.filter((item) => item.id !== id) });
  }

  async function saveMarkdownFile(name: string, content: string, label = 'Markdown') {
    if (window.desktopApi) {
      const result = await window.desktopApi.saveMarkdown(name, content);
      if (!result.canceled) message.success(`${label} 已保存`);
      return;
    }

    const blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.md`;
    link.click();
    URL.revokeObjectURL(url);
    message.success(`${label} 已导出`);
  }

  async function exportMarkdown() {
    if (!selected) return;
    const markdown = buildMarkdown(selected);
    const fileName = selected.title.replace(/[\\/:*?"<>|]/g, '_') || 'paper-note';
    await saveMarkdownFile(fileName, markdown);
  }

  async function exportMatrix() {
    if (filteredPapers.length === 0) {
      message.warning('当前筛选没有论文');
      return;
    }
    const markdown = buildLiteratureMatrix(filteredPapers);
    await saveMarkdownFile('literature-matrix', markdown, '文献矩阵');
  }

  async function exportLibrary() {
    const content = JSON.stringify(papers, null, 2);

    if (window.desktopApi) {
      const result = await window.desktopApi.exportLibrary('paper-library', content);
      if (!result.canceled) message.success('资料库已导出');
      return;
    }

    const blob = new Blob([content], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'paper-library.json';
    link.click();
    URL.revokeObjectURL(url);
    message.success('资料库已导出');
  }

  async function importLibrary() {
    if (!window.desktopApi) {
      message.warning('请在桌面版中使用资料库导入');
      return;
    }
    if (!requireDesktopLogin()) return;

    const result = await window.desktopApi.importLibrary();
    if (result.canceled || !result.content) return;

    try {
      const next = JSON.parse(result.content) as unknown;
      if (!isPaperLibrary(next) || next.length === 0) {
        message.error('导入失败：不是有效的论文资料库');
        return;
      }

      persist(next);
      setSelectedId(next[0].id);
      message.success('资料库已导入');
    } catch {
      message.error('导入失败：JSON 文件无法解析');
    }
  }

  async function importReferences() {
    if (!window.desktopApi) {
      message.warning('请在桌面版中使用文献导入');
      return;
    }
    if (!requireDesktopLogin()) return;

    const result = await window.desktopApi.importReferences();
    if (result.canceled || !result.content) return;

    let references: ImportedReference[];
    try {
      references = parseReferences(result.content, result.filePath);
    } catch (error) {
      message.error(error instanceof Error ? error.message : '导入失败：未识别到标准引用格式');
      return;
    }

    if (references.length === 0) {
      message.error('导入失败：没有识别到有效文献记录');
      return;
    }

    const existingDoiKeys = new Set(papers.map(doiKey).filter(Boolean));
    const existingTitleYearKeys = new Set(papers.map(titleYearKey).filter(Boolean));
    const imported: Paper[] = [];
    const skippedByDoi: string[] = [];
    const skippedByTitleYear: string[] = [];

    for (const reference of references) {
      const paper = makeImportedPaper(reference);
      const matchSource = matchImportedPaper(paper, existingDoiKeys, existingTitleYearKeys);
      if (matchSource === 'DOI强匹配') {
        skippedByDoi.push(paper.title);
        continue;
      }
      if (matchSource === '题名+年份弱匹配') {
        skippedByTitleYear.push(paper.title);
        continue;
      }

      const doi = doiKey(paper);
      const titleYear = titleYearKey(paper);
      if (doi) existingDoiKeys.add(doi);
      if (titleYear) existingTitleYearKeys.add(titleYear);
      imported.push(paper);
    }

    const skipped = skippedByDoi.length + skippedByTitleYear.length;
    const weakMatchText = skippedByTitleYear.length ? `，${skippedByTitleYear.length} 条题名+年份弱匹配需人工复核` : '';

    if (imported.length === 0) {
      message.warning(`未导入新文献，${skippedByDoi.length} 条 DOI 强匹配重复${weakMatchText}`);
      return;
    }

    persist([...imported, ...papers]);
    setSelectedId(imported[0].id);
    message.success(`已导入 ${imported.length} 条文献，跳过 ${skipped} 条重复（${skippedByDoi.length} 条 DOI 强匹配${weakMatchText}）`);
  }

  useEffect(() => {
    if (!window.desktopApi) return undefined;

    return window.desktopApi.onCommand((command) => {
      if (command === 'new-paper') addPaper();
      if (command === 'import-library') void importLibrary();
      if (command === 'import-references') void importReferences();
      if (command === 'export-library') void exportLibrary();
      if (command === 'export-markdown') void exportMarkdown();
    });
  });

  const moreMenuItems = [
    { key: 'import-library', label: '导入资料库', onClick: () => { void importLibrary(); } },
    { key: 'export-library', label: '导出资料库', onClick: () => { void exportLibrary(); } },
    { key: 'export-markdown', label: '导出 Markdown', onClick: () => { void exportMarkdown(); } },
    { key: 'review', label: '生成综述', onClick: openReviewDrawer },
    { key: 'matrix', label: '导出文献矩阵', onClick: () => { void exportMatrix(); } },
    { key: 'reset-samples', label: '恢复示例', onClick: resetSamples },
    { type: 'divider' as const },
    {
      key: 'delete',
      label: papers.length === 1 ? '删除（至少保留一篇）' : '删除当前论文',
      danger: true,
      disabled: papers.length === 1,
      onClick: () => {
        Modal.confirm({
          title: '确认删除当前论文？',
          content: '删除后可从资料库备份恢复，当前会话内不会自动找回。',
          okText: '删除',
          okType: 'danger',
          cancelText: '取消',
          onOk: deleteSelected,
        });
      },
    },
  ];

  return (
    <ConfigProvider
      theme={{
        algorithm: themeTokens.isDark ? theme.darkAlgorithm : theme.defaultAlgorithm,
        token: {
          colorPrimary: themeTokens.antPrimary,
          colorBgBase: themeTokens.antBgBase,
          colorTextBase: themeTokens.antTextBase,
          colorBgContainer: themeTokens.canvasBg,
          colorBgElevated: themeTokens.elevatedBg,
          colorBorder: themeTokens.border,
          colorBorderSecondary: themeTokens.border,
          controlItemBgActive: themeTokens.selectedBg,
          controlItemBgHover: themeTokens.selectedBg,
          borderRadius: 10,
          fontFamily: activeFontFamily,
        },
      }}
    >
      <AntApp>
        <Layout className="desktop-workbench">
          <AppHeader
            currentTitle={selected?.title}
            issueCount={citationIssues.length}
            saveStatus={saveStatus}
            query={query}
            accountInitial={accountInitial}
            accountOpen={activeDrawer === 'account'}
            settingsOpen={settingsOpen}
            onQueryChange={setQuery}
            onOpenQuality={openQualityDrawer}
            onOpenAccount={openAccountDrawer}
            onRetrySave={retrySave}
            onCreatePaper={addPaper}
            onImportReferences={() => { void importReferences(); }}
            moreMenuItems={moreMenuItems}
            onSettingsOpenChange={openSettingsPanel}
            displaySettings={(
              <DisplaySettings
                theme={appTheme}
                textContrast={textContrast}
                uiContrast={uiContrast}
                font={appFont}
                onThemeChange={setAppTheme}
                onTextContrastChange={setTextContrast}
                onUiContrastChange={setUiContrast}
                onFontChange={setAppFont}
                aiSettings={<AiSettings />}
              />
            )}
          />

          <div className={libraryCollapsed ? 'workbench-body library-collapsed' : 'workbench-body'}>
            <PaperLibrary
              papers={papers}
              filteredPapers={filteredPapers}
              selectedId={selected?.id ?? null}
              query={query}
              statusFilter={statusFilter}
              tagFilter={tagFilter}
              allTags={allTags}
              collapsed={libraryCollapsed}
              onQueryChange={setQuery}
              onStatusFilterChange={(value) => setStatusFilter(value as '全部' | PaperStatus)}
              onTagFilterChange={setTagFilter}
              onSelect={setSelectedId}
              onToggleCollapse={() => setLibraryCollapsed((prev) => !prev)}
            />

            {showEmptyWorkspace ? (
              <EmptyWorkspace
                sessionStatus={sessionStatus}
                onLogin={openAccountDrawer}
                onCreatePaper={addPaper}
                onImportLibrary={() => { void importLibrary(); }}
              />
            ) : (
              <PaperWorkspace
                paper={selected}
                editorSection={editorSection}
                onSectionChange={setEditorSection}
                onPaperChange={updateSelected}
                onAddEvidence={addEvidence}
                onUpdateEvidence={updateEvidence}
                onRemoveEvidence={removeEvidence}
              />
            )}
          </div>

          <QualityDrawer
            open={activeDrawer === 'quality'}
            onClose={closeDrawer}
            selected={selected}
            issues={selectedIssues}
            paperCount={papers.length}
            evidenceCount={evidenceCount}
            issueCount={citationIssues.length}
            checklistItems={checklistItems}
            onChecklistChange={(item, checked) => {
              if (!selected) return;
              updateSelected({ checklist: { ...selected.checklist, [item]: checked } });
            }}
            onImportReferences={() => { void importReferences(); }}
            onExportMarkdown={() => { void exportMarkdown(); }}
            onExportLibrary={() => { void exportLibrary(); }}
            onOpenReview={openReviewDrawer}
            onExportMatrix={() => { void exportMatrix(); }}
          />

          <ReviewDrawer
            open={activeDrawer === 'review'}
            onClose={closeDrawer}
            papers={filteredPapers}
            onSaveMarkdown={(name, content) => { void saveMarkdownFile(name, content, '综述'); }}
          />

          <AccountDrawer
            open={activeDrawer === 'account'}
            onClose={closeDrawer}
            currentUser={currentUser}
            authMode={authMode}
            authBusy={authBusy}
            authError={authError}
            loginForm={loginForm}
            registerForm={registerForm}
            accountDraft={accountDraft}
            passwordForm={passwordForm}
            onAuthModeChange={(mode) => {
              setAuthMode(mode);
              setAuthError('');
            }}
            onLoginFormChange={(patch) => setLoginForm((prev) => ({ ...prev, ...patch }))}
            onRegisterFormChange={(patch) => setRegisterForm((prev) => ({ ...prev, ...patch }))}
            onAccountDraftChange={updateAccountDraft}
            onPasswordFormChange={(patch) => setPasswordForm((prev) => ({ ...prev, ...patch }))}
            onLogin={() => { void handleLogin(); }}
            onRegister={() => { void handleRegister(); }}
            onSaveProfile={() => { void saveAccount(); }}
            onChangePassword={() => { void handleChangePassword(); }}
            onLogout={() => { void handleLogout(); }}
          />
        </Layout>
      </AntApp>
    </ConfigProvider>
  );
}

export { App };
