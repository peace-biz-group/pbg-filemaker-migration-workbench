import { Command } from 'commander';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ingestFile } from '../../io/file-reader.js';
import { generateMappingSuggestions } from '../../core/column-mapper.js';
import { loadConfig } from '../../config/defaults.js';
import type { IngestOptions } from '../../ingest/ingest-options.js';
import type { CsvIngestDiagnosis } from '../../types/index.js';

export const previewCommand = new Command('preview')
  .description('Preview file: detect encoding/delimiter, show schema and sample rows')
  .argument('<file>', 'Input CSV or XLSX file')
  .option('-c, --config <path>', 'Config file path')
  .option('--encoding <enc>', 'Encoding override: auto|utf8|cp932', 'auto')
  .option('--delimiter <delim>', 'Delimiter override: auto|,|\\t|;', 'auto')
  .option('--no-header', 'File has no header row')
  .option('--skip-rows <n>', 'Skip N rows at start', '0')
  .option('--rows <n>', 'Number of preview rows', '100')
  .option('-o, --output-dir <dir>', 'Output directory for preview.json')
  .action(async (file: string, opts: Record<string, string | boolean>) => {
    const config = loadConfig(opts.config as string | undefined);
    if (opts.outputDir) config.outputDir = opts.outputDir as string;

    const ingestOptions: IngestOptions = {
      encoding: (opts.encoding as 'auto' | 'utf8' | 'cp932') ?? 'auto',
      delimiter: (opts.delimiter as 'auto' | ',' | '\t' | ';') ?? 'auto',
      debugContext: 'cli:preview',
      hasHeader: opts.header !== false,
      skipRows: parseInt(String(opts.skipRows ?? '0'), 10),
      previewRows: parseInt(String(opts.rows ?? '100'), 10),
    };

    console.log(`\nPreview: ${file}\n`);

    const ingestResult = await ingestFile(file, ingestOptions, 5000);
    const sampleRows: Record<string, string>[] = [];

    for await (const chunk of ingestResult.records) {
      for (const row of chunk) sampleRows.push(row);
    }

    const suggestions = generateMappingSuggestions(ingestResult.schemaFingerprint, ingestResult.columns);

    const preview = {
      file,
      diagnosis: ingestResult.diagnosis,
      sourceFileHash: ingestResult.sourceFileHash,
      schemaFingerprint: ingestResult.schemaFingerprint,
      columns: ingestResult.columns,
      columnCount: ingestResult.columns.length,
      sampleRowCount: sampleRows.length,
      sampleRows,
      parseFailures: ingestResult.parseFailures,
      parseFailCount: ingestResult.parseFailures.length,
      mappingSuggestions: suggestions.suggestions,
    };

    const diag = ingestResult.diagnosis;
    if (diag.format === 'csv') {
      const csvDiag = diag as CsvIngestDiagnosis;
      console.log('Encoding:   ', `${csvDiag.detectedEncoding} (confidence: ${csvDiag.encodingConfidence}) → applied: ${csvDiag.appliedEncoding}`);
    } else {
      console.log('Encoding:    xlsx (native)');
    }
    console.log('Columns:    ', ingestResult.columns.length, ingestResult.columns.join(', '));
    console.log('Preview rows:', sampleRows.length);
    console.log('Parse fails: ', ingestResult.parseFailures.length);
    console.log('Schema FP:  ', ingestResult.schemaFingerprint.slice(0, 16) + '...');

    if (suggestions.suggestions.length > 0) {
      console.log('\nMapping suggestions:');
      for (const s of suggestions.suggestions) {
        console.log(`  ${s.sourceColumn} → ${s.suggestedCanonical} (${s.confidence})`);
      }
    }

    const outPath = join(config.outputDir, 'preview.json');
    try {
      const { mkdirSync } = await import('node:fs');
      mkdirSync(config.outputDir, { recursive: true });
      writeFileSync(outPath, JSON.stringify(preview, null, 2), 'utf-8');
      console.log(`\nPreview written to: ${outPath}`);
    } catch { /* ignore write errors */ }
  });
