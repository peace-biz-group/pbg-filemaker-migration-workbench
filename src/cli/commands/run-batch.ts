import { Command } from 'commander';
import { loadConfig } from '../../config/defaults.js';
import { profileFile } from '../../core/profiler.js';
import { normalizeFiles } from '../../core/normalizer.js';
import { detectDuplicates } from '../../core/duplicate-detector.js';
import { classifyFile } from '../../core/classifier.js';
import { writeCsv } from '../../io/csv-writer.js';
import {
  ensureOutputDir,
  writeSummaryJson,
  writeSummaryMarkdown,
} from '../../io/report-writer.js';
import { join } from 'node:path';
import type { ReportSummary, ProfileResult } from '../../types/index.js';

export const runBatchCommand = new Command('run-batch')
  .description('Run full pipeline on multiple files (from config inputs or CLI args)')
  .argument('[files...]', 'Input CSV/XLSX files (overrides config.inputs)')
  .option('-c, --config <path>', 'Config file path')
  .option('-o, --output-dir <dir>', 'Output directory')
  .action(async (files: string[], opts: { config?: string; outputDir?: string }) => {
    const config = loadConfig(opts.config);
    if (opts.outputDir) config.outputDir = opts.outputDir;
    ensureOutputDir(config.outputDir);

    // Determine input files: CLI args take priority over config.inputs
    const inputFiles = files.length > 0
      ? files.map((f) => ({ path: f, label: f }))
      : config.inputs.map((i) => ({ path: i.path, label: i.label ?? i.path }));

    if (inputFiles.length === 0) {
      console.error('Error: No input files specified. Provide files as arguments or in config.inputs.');
      process.exit(1);
    }

    console.log('=== FileMaker Data Workbench — Batch Pipeline ===\n');
    console.log(`Input files (${inputFiles.length}):`);
    for (const f of inputFiles) {
      console.log(`  - ${f.label} (${f.path})`);
    }
    console.log();

    // 1. Profile each file
    console.log('[1/4] Profiling...');
    const profiles: ProfileResult[] = [];
    let totalRecords = 0;
    let totalColumns = 0;

    for (const f of inputFiles) {
      const profile = await profileFile(f.path, config);
      profiles.push(profile);
      totalRecords += profile.recordCount;
      totalColumns = Math.max(totalColumns, profile.columnCount);
      console.log(`  ${f.label}: ${profile.recordCount.toLocaleString()} records, ${profile.columnCount} columns, ${profile.anomalies.length} anomalies`);
    }

    // Merge anomalies
    const allAnomalies = profiles.flatMap((p) =>
      p.anomalies.map((a) => ({
        file: p.fileName,
        row: String(a.row),
        column: a.column,
        value: a.value,
        reason: a.reason,
      })),
    );
    if (allAnomalies.length > 0) {
      await writeCsv(join(config.outputDir, 'anomalies.csv'), allAnomalies);
    }

    // 2. Normalize all files into merged output
    console.log('\n[2/4] Normalizing (merged)...');
    const normResult = await normalizeFiles(inputFiles, config);
    console.log(`  Normalized: ${normResult.normalizedCount.toLocaleString()}, Quarantine: ${normResult.quarantineCount.toLocaleString()}`);

    // 3. Detect duplicates across all files
    console.log('\n[3/4] Detecting duplicates (cross-file)...');
    const dupResult = await detectDuplicates(normResult.normalizedPath, config);
    console.log(`  Duplicate groups: ${dupResult.groups.length.toLocaleString()}`);
    const byType: Record<string, number> = {};
    for (const g of dupResult.groups) {
      byType[g.matchType] = (byType[g.matchType] ?? 0) + 1;
    }
    for (const [type, count] of Object.entries(byType)) {
      console.log(`    ${type}: ${count} groups`);
    }

    // Cross-file duplicates
    const crossFileGroups = dupResult.groups.filter((g) => {
      const sources = new Set(g.records.map((r) => r.values['_source_file']));
      return sources.size > 1;
    });
    if (crossFileGroups.length > 0) {
      console.log(`  Cross-file groups: ${crossFileGroups.length}`);
    }

    // 4. Classify
    console.log('\n[4/4] Classifying...');
    const classResult = await classifyFile(normResult.normalizedPath, config);
    console.log('  Breakdown:');
    for (const [type, count] of Object.entries(classResult.breakdown)) {
      if (count > 0) console.log(`    ${type}: ${count.toLocaleString()}`);
    }

    // Write summary
    const summary: ReportSummary = {
      generatedAt: new Date().toISOString(),
      inputFile: inputFiles.map((f) => f.label).join(', '),
      recordCount: totalRecords,
      columnCount: totalColumns,
      normalizedCount: normResult.normalizedCount,
      quarantineCount: normResult.quarantineCount,
      duplicateGroupCount: dupResult.groups.length,
      classificationBreakdown: classResult.breakdown,
    };
    writeSummaryJson(config.outputDir, summary);

    // Use first profile for column details in markdown
    writeSummaryMarkdown(config.outputDir, summary, profiles[0]);

    console.log(`\n=== Done. Output: ${config.outputDir}/ ===`);
  });
