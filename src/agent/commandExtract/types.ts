export type CommandIntent =
  | 'disk_capacity'
  | 'disk_growth'
  | 'project_status'
  | 'project_index'
  | 'code_search'
  | 'file_read'
  | 'runtime_info'
  | 'process_memory'
  | 'recent_activity'
  | 'code_edit'
  | 'shell_command'
  | 'unknown';

export type Confidence = 'high' | 'medium' | 'low';

export type CommandSlots = {
  path?: string;
  query?: string;
  drive?: string;
  hours?: number;
  minMb?: number;
  limit?: number;
  command?: string;
};

export type ExtractionResult = {
  intent: CommandIntent;
  slots: CommandSlots;
  confidence: Confidence;
  reasons: string[];
};

export type PlannedToolStep = {
  tool: string;
  input: Record<string, unknown>;
};

export type CommandPlan = {
  mode: 'execute' | 'strategy';
  steps: PlannedToolStep[];
  recommendedTools: string[];
  avoidTools: string[];
  reason: string;
};
