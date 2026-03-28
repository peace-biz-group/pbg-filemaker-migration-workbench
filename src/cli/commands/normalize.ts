import { Command } from 'commander';
import { loadConfig } from '../../config/defaults.js';
import { normalizeFile } from '../../core/normalizer.js';

export const normalizeCommand = new Command('normalize')
  .description('Normalize a CSV/XLSX file — phone, email, text, dates')
  .argument('<file>', 'Input CSV or XLSX file')
  .option('-c, --config <path>', 'Config file path')
  .option('-o, --output-dir <dir>', 'Output directory')
  .action(async (file: string, opts: { config?: string; outputDir?: string }) => {
    const config = loadConfig(opts.config);
    if (opts.outputDir) config.outputDir = opts.outputDir;

    console.log(`Normalizing: ${file}`);
    const result = await normalizeFile(file, config);

    console.log(`  Normalized: ${result.normalizedCount.toLocaleString()} records → ${result.normalizedPath}`);
    console.log(`  Quarantine: ${result.quarantineCount.toLocaleString()} records → ${result.quarantinePath}`);
  });
