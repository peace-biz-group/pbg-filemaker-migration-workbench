import { Command } from 'commander';
import { loadConfig } from '../../config/defaults.js';
import { defaultSplitOutputDir, splitCsvFile } from '../../core/huge-csv-split.js';
import { addIngestOptions, parseIngestOptions } from './_ingest-opts.js';

export const splitCommand = addIngestOptions(
  new Command('split')
    .description('巨大 CSV を安全に分割する')
    .argument('<file>', 'Input CSV file')
    .option('-c, --config <path>', 'Config file path')
    .option('-o, --output-dir <dir>', 'Output directory')
    .option('--rows <n>', 'Rows per split file', '500000')
    .action(async (file: string, opts: Record<string, string | boolean>) => {
      const config = loadConfig(opts.config as string | undefined);
      const outputDir = opts.outputDir
        ? String(opts.outputDir)
        : defaultSplitOutputDir(config.outputDir, file);
      const manifest = await splitCsvFile(file, {
        outputDir,
        rowsPerPart: parseInt(String(opts.rows ?? '500000'), 10),
        ingestOptions: parseIngestOptions(opts),
      });

      console.log(`Split completed: ${manifest.totalParts} parts`);
      console.log(`Rows: ${manifest.totalRows}`);
      console.log(`Schema FP: ${manifest.schemaFingerprint}`);
      console.log(`Output: ${outputDir}`);
      console.log(`Manifest: ${outputDir}/split-manifest.json`);
    }),
);
