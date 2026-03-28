import { Command } from 'commander';
import { loadConfig } from '../../config/defaults.js';
import { profileFile } from '../../core/profiler.js';
import { writeCsv } from '../../io/csv-writer.js';
import { ensureOutputDir, writeSummaryJson, writeSummaryMarkdown } from '../../io/report-writer.js';
import { join } from 'node:path';
import type { ReportSummary } from '../../types/index.js';

export const profileCommand = new Command('profile')
  .description('Profile a CSV/XLSX file — column stats, missing rates, anomalies')
  .argument('<file>', 'Input CSV or XLSX file')
  .option('-c, --config <path>', 'Config file path')
  .option('-o, --output-dir <dir>', 'Output directory')
  .action(async (file: string, opts: { config?: string; outputDir?: string }) => {
    const config = loadConfig(opts.config);
    if (opts.outputDir) config.outputDir = opts.outputDir;
    ensureOutputDir(config.outputDir);

    console.log(`Profiling: ${file}`);
    const profile = await profileFile(file, config);

    console.log(`  Records: ${profile.recordCount.toLocaleString()}`);
    console.log(`  Columns: ${profile.columnCount}`);
    console.log(`  Anomalies: ${profile.anomalies.length.toLocaleString()}`);

    // Write anomalies.csv
    if (profile.anomalies.length > 0) {
      const anomalyPath = join(config.outputDir, 'anomalies.csv');
      await writeCsv(anomalyPath, profile.anomalies.map((a) => ({
        row: String(a.row),
        column: a.column,
        value: a.value,
        reason: a.reason,
      })));
      console.log(`  Anomalies written to: ${anomalyPath}`);
    }

    const summary: ReportSummary = {
      generatedAt: new Date().toISOString(),
      inputFile: file,
      recordCount: profile.recordCount,
      columnCount: profile.columnCount,
      normalizedCount: 0,
      quarantineCount: 0,
      duplicateGroupCount: 0,
      classificationBreakdown: { customer: 0, deal: 0, transaction: 0, activity: 0, quarantine: 0 },
    };
    writeSummaryJson(config.outputDir, summary);
    writeSummaryMarkdown(config.outputDir, summary, profile);

    console.log(`  Reports written to: ${config.outputDir}/`);
  });
