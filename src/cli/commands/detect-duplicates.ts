import { Command } from 'commander';
import { loadConfig } from '../../config/defaults.js';
import { detectDuplicates } from '../../core/duplicate-detector.js';

export const detectDuplicatesCommand = new Command('detect-duplicates')
  .description('Detect duplicate candidates by phone, email, name+company, name+address')
  .argument('<file>', 'Input CSV file (ideally normalized.csv)')
  .option('-c, --config <path>', 'Config file path')
  .option('-o, --output-dir <dir>', 'Output directory')
  .action(async (file: string, opts: { config?: string; outputDir?: string }) => {
    const config = loadConfig(opts.config);
    if (opts.outputDir) config.outputDir = opts.outputDir;

    console.log(`Detecting duplicates: ${file}`);
    const result = await detectDuplicates(file, config);

    console.log(`  Duplicate groups: ${result.groups.length.toLocaleString()}`);

    const byType: Record<string, number> = {};
    for (const g of result.groups) {
      byType[g.matchType] = (byType[g.matchType] ?? 0) + 1;
    }
    for (const [type, count] of Object.entries(byType)) {
      console.log(`    ${type}: ${count} groups`);
    }
    console.log(`  Output: ${result.outputPath}`);
  });
