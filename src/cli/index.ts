#!/usr/bin/env node

import { Command } from 'commander';
import { profileCommand } from './commands/profile.js';
import { normalizeCommand } from './commands/normalize.js';
import { detectDuplicatesCommand } from './commands/detect-duplicates.js';
import { classifyCommand } from './commands/classify.js';
import { runAllCommand } from './commands/run-all.js';
import { runBatchCommand } from './commands/run-batch.js';
import { previewCommand } from './commands/preview.js';
import { splitCommand } from './commands/split.js';
import { splitRunCommand } from './commands/split-run.js';

const program = new Command();

program
  .name('fm-workbench')
  .description('FileMaker Data Workbench — CSV/XLSX の調査・正規化・重複候補抽出・分類・レポート出力')
  .version('0.3.0');

program.addCommand(profileCommand);
program.addCommand(normalizeCommand);
program.addCommand(detectDuplicatesCommand);
program.addCommand(classifyCommand);
program.addCommand(runAllCommand);
program.addCommand(runBatchCommand);
program.addCommand(previewCommand);
program.addCommand(splitCommand);
program.addCommand(splitRunCommand);

program.parse();
