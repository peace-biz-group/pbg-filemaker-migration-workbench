export type CsvQuoteMode = 'auto' | 'strict' | 'relaxed' | 'literal';

export interface IngestOptions {
  encoding?: 'auto' | 'utf8' | 'cp932';
  delimiter?: 'auto' | ',' | '\t' | ';';
  csvQuoteMode?: CsvQuoteMode;
  debugContext?: string;
  hasHeader?: boolean | 'auto';
  skipRows?: number;
  previewRows?: number;
}

export const DEFAULT_INGEST_OPTIONS = {
  encoding: 'auto' as const,
  delimiter: 'auto' as const,
  csvQuoteMode: 'auto' as const,
  hasHeader: 'auto' as const,
  skipRows: 0,
};
