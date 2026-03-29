export interface IngestOptions {
  encoding?: 'auto' | 'utf8' | 'cp932';
  delimiter?: 'auto' | ',' | '\t' | ';';
  hasHeader?: boolean;
  skipRows?: number;
  previewRows?: number;
}

export const DEFAULT_INGEST_OPTIONS = {
  encoding: 'auto' as const,
  delimiter: 'auto' as const,
  hasHeader: true,
  skipRows: 0,
};
