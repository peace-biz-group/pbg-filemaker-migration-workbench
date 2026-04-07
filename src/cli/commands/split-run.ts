import { Command } from 'commander';
import { loadConfig } from '../../config/defaults.js';
import { resumeSplitRun, startSplitRun } from '../../core/huge-csv-split-run.js';
import { addIngestOptions, parseIngestOptions } from './_ingest-opts.js';

function formatResumeStop(summary: {
  stopReason: string | null;
  reusableRunCandidateIds?: string[];
  stoppedAtPartIndex?: number;
}): string {
  switch (summary.stopReason) {
    case 'reusable_context_missing':
      return '再利用できる run が見つからないため停止しました';
    case 'ambiguous_reusable_context':
      return `再利用候補が複数あるため停止しました: ${(summary.reusableRunCandidateIds ?? []).join(', ')}`;
    case 'schema_changed':
      return `schemaFingerprint が part ${summary.stoppedAtPartIndex ?? '?'} で変化したため停止しました`;
    default:
      return `Stop reason: ${summary.stopReason ?? 'none'}`;
  }
}

export const splitRunCommand = addIngestOptions(
  new Command('split-run')
    .description('巨大 CSV を分割し、part001 実行と resume を行う')
    .argument('[file]', 'Input CSV file')
    .option('-c, --config <path>', 'Config file path')
    .option('-o, --output-dir <dir>', 'Output directory')
    .option('--rows <n>', 'Rows per split file', '500000')
    .option('--mode <mode>', 'Run mode: normalize|run-all', 'normalize')
    .option('--resume-from-manifest <path>', 'Resume from saved split manifest')
    .option('--manifest <path>', 'Manifest path used with --reuse-run')
    .option('--reuse-run <runId>', 'Reuse context from an existing part001 run')
    .action(async (file: string | undefined, opts: Record<string, string | boolean>) => {
      const config = loadConfig(opts.config as string | undefined);

      if (opts.resumeFromManifest || opts.reuseRun) {
        const manifestPath = String(opts.resumeFromManifest ?? opts.manifest ?? '');
        if (!manifestPath) {
          throw new Error('resume には --resume-from-manifest か --manifest が必要です');
        }
        const summary = await resumeSplitRun({
          manifestPath,
          config,
          configPath: opts.config as string | undefined,
          reuseRunId: opts.reuseRun ? String(opts.reuseRun) : undefined,
        });
        console.log(`Resume stage: ${summary.stage}`);
        console.log(`Completed parts: ${summary.completedParts}/${summary.totalParts}`);
        console.log(formatResumeStop(summary));
        console.log(`Reused from run: ${summary.reusedFromRunId ?? 'none'}`);
        if (summary.stage !== 'resume_completed' && summary.stopReason === 'ambiguous_reusable_context') {
          console.log(`必要なら手動指定: split-run --resume-from-manifest "${manifestPath}" --reuse-run <runId>`);
        }
        return;
      }

      if (!file) {
        throw new Error('初回 split-run には <file> が必要です');
      }

      const summary = await startSplitRun({
        filePath: file,
        config,
        configPath: opts.config as string | undefined,
        mode: String(opts.mode ?? 'normalize') as 'normalize' | 'run-all',
        rowsPerPart: parseInt(String(opts.rows ?? '500000'), 10),
        outputDir: opts.outputDir ? String(opts.outputDir) : undefined,
        ingestOptions: parseIngestOptions(opts),
      });

      console.log(`Stage: ${summary.stage}`);
      console.log(`Completed parts: ${summary.completedParts}/${summary.totalParts}`);
      console.log(`Manifest: ${summary.splitManifestPath}`);
      console.log('part 001 を確認後、このコマンドで再開:');
      console.log(`npx tsx src/cli/index.ts split-run --resume-from-manifest "${summary.splitManifestPath}"`);
    }),
);
