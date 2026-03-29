import type { Command } from 'commander';
import type { IngestOptions } from '../../ingest/ingest-options.js';

export function addIngestOptions(cmd: Command): Command {
  return cmd
    .option('--encoding <enc>', 'Encoding: auto|utf8|cp932', 'auto')
    .option('--delimiter <delim>', 'Delimiter: auto|,|\\t|;', 'auto')
    .option('--no-header', 'File has no header row')
    .option('--skip-rows <n>', 'Skip N rows', '0')
    .option('--preview-rows <n>', 'Limit to N rows (preview mode)');
}

export function parseIngestOptions(opts: Record<string, string | boolean>): IngestOptions {
  return {
    encoding: (opts.encoding as IngestOptions['encoding']) ?? 'auto',
    delimiter: (opts.delimiter as IngestOptions['delimiter']) ?? 'auto',
    hasHeader: opts.header !== false,
    skipRows: opts.skipRows ? parseInt(String(opts.skipRows), 10) : 0,
    previewRows: opts.previewRows ? parseInt(String(opts.previewRows), 10) : undefined,
  };
}
