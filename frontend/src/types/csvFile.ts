export interface CsvRow {
  id: number;
  post_id: number;
  name: string;
  email: string;
  body: string;
  date_created: string;
  version: number;
  is_stale?: boolean;
  is_deleted?: boolean;
}

export interface RowFilters {
  search?: string;
  from?: string;
  to?: string;
}

export interface RowHistory {
  id: number;
  row_id: number;
  post_id: number;
  name: string;
  email: string;
  body: string;
  date_created: string;
  version: number;
  date_archived: string;
}

export type SocketMessage =
  | { type: 'connected'; clientId: string }
  | { type: 'rows_updated' | 'rows_deleted'; ids: number[] };

export interface PaginationMetadata  {
  totalItems: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface RowResponse {
  metadata: PaginationMetadata;
  data: CsvRow[];
}

export interface ImportJob {
  id: string;
  name: string;
  status: 'processing' | 'waiting' | 'completed' | 'failed' | 'stale';
  total_rows: number | null;
  processed_rows: number;
  error: string | null;
  changed_rows?: ChangedRow[];
  concurrent_changes?: ChangedRow[];
}

export interface ChangedRow {
  id: number;
  old: CsvRow | null;
  new: CsvRow | null;
}