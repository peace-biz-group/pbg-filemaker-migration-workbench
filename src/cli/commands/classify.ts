import { Command } from 'commander';
import { loadConfig } from '../../config/defaults.js';
import { classifyFile } from '../../core/classifier.js';

export const classifyCommand = new Command('classify')
  .description('Classify records into customer/deal/transaction/activity/quarantine candidates')
  .argument('<file>', 'Input CSV file (ideally normalized.csv)')
  .option('-c, --config <path>', 'Config file path')
  .option('-o, --output-dir <dir>', 'Output directory')
  .action(async (file: string, opts: { config?: string; outputDir?: string }) => {
    const config = loadConfig(opts.config);
    if (opts.outputDir) config.outputDir = opts.outputDir;

    console.log(`Classifying: ${file}`);
    const result = await classifyFile(file, config);

    console.log('  Breakdown:');
    for (const [type, count] of Object.entries(result.breakdown)) {
      console.log(`    ${type}: ${count.toLocaleString()}`);
    }
    console.log(`  Output: ${result.outputPath}`);
  });
