export interface CsvFile {
  id: number;
  name: string;
  path: string;
  date_uploaded: string;
}

export interface PaginationMetadata  {
  totalItems: number;
  totalPages: number;
  currentPage: number;
  pageSize: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export interface FileListResponse {
  data: CsvFile[];
  metaData: PaginationMetadata
}
