export type EditorSection = 'overview' | 'notes' | 'evidence';
export type PaperStatus = '未读' | '粗读' | '精读' | '已摘录' | '待复核';
export type Reliability = '高' | '中' | '低';

export type Evidence = {
  id: string;
  claim: string;
  support: string;
  locator: string;
  reliability: Reliability;
  tags: string[];
};

export type Paper = {
  id: string;
  title: string;
  authors: string;
  year: string;
  source: string;
  doi: string;
  url: string;
  status: PaperStatus;
  tags: string[];
  question: string;
  method: string;
  dataset: string;
  findings: string;
  limitations: string;
  credibility: string;
  evidence: Evidence[];
  checklist: Record<string, boolean>;
};

export type AuthUser = {
  id: string;
  username: string;
  email: string;
  displayName: string;
  institution: string;
  researchField: string;
  notes: string;
};

export type AccountProfile = {
  displayName: string;
  institution: string;
  researchField: string;
  email: string;
  notes: string;
};

export type AuthResult = { ok: true; user: AuthUser } | { ok: false; error: string };
