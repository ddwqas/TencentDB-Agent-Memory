/** 一次文档分析的固定范围，独立于分页、筛选和后续原文更新。 */
export interface WikiAnalysisScope {
  task_id: string;
  filenames: string[];
  deleted_filenames: string[];
  force: boolean;
  retry_filenames?: string[];
}

export interface WikiSelectionRequest {
  filenames: string[];
  deleted_filenames?: string[];
  force?: boolean;
}

export interface WikiDocument {
  filename: string;
  size: number;
  status: 'pending' | 'changed' | 'processing' | 'completed' | 'failed' | 'deleted';
  error?: string | null;
}
