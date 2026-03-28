import { Command } from 'commander';
import { loadConfig } from '../../config/defaults.js';
import { profileFile } from '../../core/profiler.js';
import { normalizeFile } from '../../core/normalizer.js';
import { detectDuplicates } from '../../core/duplicate-detector.js';
import { classifyFile } from '../../core/classifier.js';
import { writeCsv } from '../../io/csv-writer.js';
import {
  ensureOutputDir,
  writeSummaryJson,
  writeSummaryMarkdown,
} from '../../io/report-writer.js';
import { findColumnMapping } from '../../core/column-mapper.js';
import { join } from 'node:path';
import type { ReportSummary } from '../../types/index.js';

export const runAllCommand = new Command('run-all')
  .description('Run full pipeline on a single file: profile → normalize → detect-duplicates → classify')
  .argument('<file>', 'Input CSV or XLSX file')
  .option('-c, --config <path>', 'Config file path')
  .option('-o, --output-dir <dir>', 'Output directory')
  .action(async (file: string, opts: { config?: string; outputDir?: string }) => {
    const config = loadConfig(opts.config);
    if (opts.outputDir) config.outputDir = opts.outputDir;
    ensureOutputDir(config.outputDir);

    console.log('=== FileMaker Data Workbench — Full Pipeline ===\n');

    // Show column mapping info
    const mapping = findColumnMapping(file, config);
    if (mapping) {
      const mappedCount = Object.keys(mapping).length;
      console.log(`Column mapping applied: ${mappedCount} columns will be renamed\n`);
    }

    // 1. Profile
    console.log('[1/4] Profiling...');
    const profile = await profileFile(file, config);
    console.log(`  Records: ${profile.recordCount.toLocaleString()}, Columns: ${profile.columnCount}, Anomalies: ${profile.anomalies.length.toLocaleString()}`);

    if (profile.anomalies.length > 0) {
      await writeCsv(
        join(config.outputDir, 'anomalies.csv'),
        profile.anomalies.map((a) => ({
          row: String(a.row),
          column: a.column,
          value: a.value,
          reason: a.reason,
        })),
      );
    }

    // 2. Normalize
    console.log('[2/4] Normalizing...');
    const normResult = await normalizeFile(file, config);
    console.log(`  Normalized: ${normResult.normalizedCount.toLocaleString()}, Quarantine: ${normResult.quarantineCount.toLocaleString()}`);

    // 3. Detect duplicates (on normalized output)
    console.log('[3/4] Detecting duplicates...');
    const dupResult = await detectDuplicates(normResult.normalizedPath, config);
    console.log(`  Duplicate groups: ${dupResult.groups.length.toLocaleString()}`);

    // 4. Classify (on normalized output)
    console.log('[4/4] Classifying...');
    const classResult = await classifyFile(normResult.normalizedPath, config);
    console.log('  Breakdown:', classResult.breakdown);

    // Write final summary
    const summary: ReportSummary = {
      generatedAt: new Date().toISOString(),
      inputFile: file,
      recordCount: profile.recordCount,
      columnCount: profile.columnCount,
      normalizedCount: normResult.normalizedCount,
      quarantineCount: normResult.quarantineCount,
      duplicateGroupCount: dupResult.groups.length,
      classificationBreakdown: classResult.breakdown,
    };
    writeSummaryJson(config.outputDir, summary);
    writeSummaryMarkdown(config.outputDir, summary, profile);

    console.log(`\n=== Done. Output: ${config.outputDir}/ ===`);
  });
