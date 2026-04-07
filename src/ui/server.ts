#!/usr/bin/env node

/**
 * Local-only review UI server.
 * Express + static HTML. No auth, no cloud, no external deps beyond express.
 */

import express from 'express';
import multer from 'multer';
import { resolve, join, extname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/defaults.js';
import { executeRun, listRuns, getRun, getRunOutputFiles, deleteRun, getRunEmitter, patchRunMeta } from '../core/pipeline-runner.js';
import type { RunMode, ProgressEvent } from '../core/pipeline-runner.js';
import type { IngestOptions } from '../ingest/ingest-options.js';
import {
  loadProfiles, getProfiles, getProfileById, matchProfile,
  saveProfiles, saveColumnReview, loadColumnReview,
  buildCandidateProfile, saveCandidateProfile,
} from '../file-profiles/index.js';
import type { FileProfile, ColumnReviewEntry } from '../file-profiles/index.js';
import { buildAutoReviews } from '../file-profiles/fast-path.js';
import {
  buildEffectiveMapping,
  reconcileColumnReviews,
  saveEffectiveMapping,
  loadEffectiveMapping,
  findEffectiveMappings,
} from '../core/effective-mapping.js';
import { detectHeaderLikelihood } from '../ingest/header-detector.js';
import { scanForMojibake } from '../ingest/mojibake-detector.js';
import {
  createReview, listReviews, getReview, updateReviewColumns,
  updateReviewSummary, deleteReview as deleteReviewBundle,
  getReviewOutputFiles, generateBundle, computeSchemaFingerprint,
} from '../core/review-bundle.js';
import { loadMemory, addResolution, saveMemory } from '../core/resolution-memory.js';
import { runAutoApplyPreview } from '../core/auto-apply-orchestrator.js';
import type { ResolutionRecord } from '../core/resolution-memory.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const VALID_MODES: RunMode[] = ['profile', 'normalize', 'detect-duplicates', 'classify', 'run-all', 'run-batch'];

function decodeUploadedFilename(name: string): string {
  try {
    // multer/busboy may decode UTF-8 filename as latin1.
    // Re-decode only when the source string looks like mojibake.
    const hasJapanese = /[\u3040-\u30FF\u4E00-\u9FFF]/.test(name);
    const latin1NoiseChars = (name.match(/[\u00C0-\u00FF]/g) || []).length;
    const looksMojibake = !hasJapanese && (/[ÃÂ¢¤¦¨±¼½¾]/.test(name) || latin1NoiseChars >= 2);
    if (!looksMojibake) return name;
    const decoded = Buffer.from(name, 'latin1').toString('utf8').normalize('NFC');
    if (!decoded || decoded.includes('\uFFFD')) return name;
    // Guard: if re-encoded bytes diverge too much, keep original.
    const roundtrip = Buffer.from(decoded, 'utf8').toString('latin1');
    if (roundtrip.length < Math.max(1, name.length / 2)) return name;
    return decoded;
  } catch {
    return name;
  }
}

function toUserFacingCsvError(err: unknown): { message: string; detail?: string } {
  const raw = err instanceof Error ? err.message : String(err);
  const lineMatch = raw.match(/line[:\s]+(\d+)/i);
  const lineInfo = lineMatch ? `（${lineMatch[1]}行目あたり）` : '';

  if (/Invalid Closing Quote/i.test(raw) || /Quote Not Closed/i.test(raw)) {
    return {
      message: `このCSVはそのまま読めませんでした${lineInfo}。途中の記号の並びがおかしい可能性があります。`,
      detail: '文字コードを UTF-8 / CP932 で切り替えるか、FileMaker からタブ区切りで出し直してください。',
    };
  }
  if (/CSV_RECORD_INCONSISTENT_FIELDS_LENGTH|Invalid Record Length/i.test(raw)) {
    return {
      message: `このCSVは行ごとの項目数がそろっていません${lineInfo}。`,
      detail: 'CSVを書き出し直すか、タブ区切りで再出力して試してください。',
    };
  }
  return {
    message: 'このファイルはそのまま読めませんでした。',
    detail: '文字コードを切り替えるか、ファイルを書き出し直してお試しください。',
  };
}

export function createApp(baseOutputDir: string, bundleDir?: string) {
  const app = express();
  app.use(express.json());

  // Load file profiles on startup
  loadProfiles(baseOutputDir);

  // Resolved bundle directory for submitted review bundles
  const resolvedBundleDir = resolve(bundleDir || join(baseOutputDir, 'review-bundles'));
  const submittedDir = join(resolvedBundleDir, 'submitted');
  const checkedDir = join(resolvedBundleDir, 'checked');
  const reworkDir = join(resolvedBundleDir, 'rework');
  for (const d of [submittedDir, checkedDir, reworkDir]) {
    mkdirSync(d, { recursive: true });
  }

  // Static files
  app.use('/static', express.static(join(__dirname, 'public')));

  // Upload temp dir
  const uploadDir = join(baseOutputDir, '.uploads');
  mkdirSync(uploadDir, { recursive: true });
  const upload = multer({ dest: uploadDir });

  function getRunColumnsForReview(runId: string): string[] {
    const run = getRun(baseOutputDir, runId);
    if (!run) return [];
    const firstFile = run.inputFiles[0];
    if (!firstFile) return [];
    return run.inputColumns?.[firstFile] ?? run.columnNames ?? [];
  }

  // --- Pages (serve index.html for all page routes) ---
  const indexHtml = join(__dirname, 'public', 'index.html');
  for (const route of ['/', '/new', '/confirm', '/runs/:id', '/runs/:id/columns']) {
    app.get(route, (_req, res) => {
      res.sendFile(indexHtml);
    });
  }

  // --- API: List runs ---
  app.get('/api/runs', (_req, res) => {
    const runs = listRuns(baseOutputDir);
    res.json(runs);
  });

  // --- API: Get single run ---
  app.get('/api/runs/:id', (req, res) => {
    const run = getRun(baseOutputDir, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });
    res.json(run);
  });

  // --- API: Get run output file list ---
  app.get('/api/runs/:id/files', (req, res) => {
    const files = getRunOutputFiles(baseOutputDir, req.params.id);
    res.json(files);
  });

  // --- API: Read CSV data from a run's output file (paginated, streaming) ---
  app.get('/api/runs/:id/data/:filename', async (req, res) => {
    const run = getRun(baseOutputDir, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const filePath = join(run.outputDir, req.params.filename);
    if (!existsSync(filePath) || extname(filePath) !== '.csv') {
      return res.status(404).json({ error: 'File not found' });
    }

    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10));
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10), 500);

    try {
      const { createReadStream } = await import('node:fs');
      const { parse: csvParse } = await import('csv-parse');

      // Count total first (fast scan)
      let totalCount = 0;
      const countStream = createReadStream(filePath).pipe(csvParse({ columns: true, skip_empty_lines: true, bom: true }));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _row of countStream) totalCount++;

      // Read the slice using from/to record numbers (1-indexed, header excluded)
      const rows: Record<string, string>[] = [];
      let columns: string[] = [];

      const readStream = createReadStream(filePath).pipe(
        csvParse({
          columns: true,
          skip_empty_lines: true,
          bom: true,
          from: offset + 1,
          to: offset + limit,
        })
      );
      for await (const row of readStream) {
        if (columns.length === 0) columns = Object.keys(row as Record<string, string>);
        rows.push(row as Record<string, string>);
      }

      res.json({ columns, totalCount, offset, limit, rows });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Read failed' });
    }
  });

  // --- API: Read raw output file ---
  app.get('/api/runs/:id/raw/:filename', (req, res) => {
    const run = getRun(baseOutputDir, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const filePath = join(run.outputDir, req.params.filename);
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found' });
    }
    res.sendFile(resolve(filePath));
  });

  // --- API: Execute a new run ---
  app.post('/api/runs', upload.array('files'), async (req, res) => {
    try {
      const mode = req.body.mode as RunMode;
      if (!VALID_MODES.includes(mode)) {
        return res.status(400).json({ error: `Invalid mode: ${mode}` });
      }

      const configPath = req.body.configPath || undefined;
      const config = loadConfig(configPath);
      config.outputDir = baseOutputDir;

      // Parse ingestOptions from body if provided
      if (req.body.ingestOptions) {
        try {
          const io = typeof req.body.ingestOptions === 'string'
            ? JSON.parse(req.body.ingestOptions)
            : req.body.ingestOptions;
          config.ingestOptions = io;
        } catch { /* ignore parse errors */ }
      }

      // Collect input file paths
      let inputFiles: string[] = [];

      // Files uploaded via multipart — rename to preserve original filename
      const uploaded = req.files as Express.Multer.File[] | undefined;
      if (uploaded && uploaded.length > 0) {
        const { renameSync } = await import('node:fs');
        inputFiles = uploaded.map((f) => {
          const readableName = decodeUploadedFilename(f.originalname);
          const dest = join(uploadDir, readableName);
          renameSync(f.path, dest);
          return dest;
        });
      }

      // Or file paths specified directly
      if (req.body.filePaths) {
        const paths = typeof req.body.filePaths === 'string'
          ? JSON.parse(req.body.filePaths)
          : req.body.filePaths;
        inputFiles = [...inputFiles, ...paths.map((p: string) => resolve(p))];
      }

      if (inputFiles.length === 0) {
        return res.status(400).json({ error: 'No input files provided' });
      }

      // Validate files exist
      for (const f of inputFiles) {
        if (!existsSync(f)) {
          return res.status(400).json({ error: `File not found: ${f}` });
        }
      }

      const meta = await executeRun(mode, inputFiles, config, configPath);
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Execution failed' });
    }
  });

  // --- API: Delete a run ---
  app.delete('/api/runs/:id', (req, res) => {
    const deleted = deleteRun(baseOutputDir, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Run not found' });
    res.json({ ok: true });
  });

  // --- API: Re-run (clone settings from existing run) ---
  app.post('/api/runs/:id/rerun', async (req, res) => {
    try {
      const original = getRun(baseOutputDir, req.params.id);
      if (!original) return res.status(404).json({ error: 'Run not found' });

      const configPath = original.configPath || undefined;
      const config = loadConfig(configPath);
      config.outputDir = baseOutputDir;

      const meta = await executeRun(original.mode, original.inputFiles, config, configPath);
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Re-run failed' });
    }
  });

  // --- API: SSE progress stream ---
  app.get('/api/runs/:id/progress', (req, res) => {
    const runId = req.params.id;
    const emitter = getRunEmitter(runId);

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });

    if (!emitter) {
      // Run already finished or doesn't exist
      const run = getRun(baseOutputDir, runId);
      const status = run ? run.status : 'not_found';
      res.write(`data: ${JSON.stringify({ step: 'done', detail: status, percent: 100 })}\n\n`);
      res.end();
      return;
    }

    const onProgress = (evt: ProgressEvent) => {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    };
    const onComplete = () => {
      res.write(`data: ${JSON.stringify({ step: 'done', detail: 'completed', percent: 100 })}\n\n`);
      res.end();
    };
    const onError = () => {
      res.write(`data: ${JSON.stringify({ step: 'done', detail: 'failed', percent: 100 })}\n\n`);
      res.end();
    };

    emitter.on('progress', onProgress);
    emitter.on('complete', onComplete);
    emitter.on('error', onError);

    req.on('close', () => {
      emitter.off('progress', onProgress);
      emitter.off('complete', onComplete);
      emitter.off('error', onError);
    });
  });

  // --- API: Read source (original input) data for before/after comparison (streaming) ---
  app.get('/api/runs/:id/source-data', async (req, res) => {
    const run = getRun(baseOutputDir, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const fileIndex = parseInt(String(req.query.fileIndex ?? '0'), 10);
    if (fileIndex < 0 || fileIndex >= run.inputFiles.length) {
      return res.status(400).json({ error: 'Invalid fileIndex' });
    }
    const filePath = run.inputFiles[fileIndex];
    if (!existsSync(filePath) || extname(filePath) !== '.csv') {
      return res.status(404).json({ error: 'Source file not found or not CSV' });
    }

    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10));
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10), 500);

    try {
      const { ingestFile } = await import('../io/file-reader.js');
      const absPath = resolve(filePath);
      const savedDiagnosis = run.ingestDiagnoses?.[absPath];
      const ingestOptions: IngestOptions = savedDiagnosis && savedDiagnosis.format === 'csv'
        ? {
          encoding: savedDiagnosis.appliedEncoding,
          delimiter: savedDiagnosis.appliedDelimiter,
          csvQuoteMode: savedDiagnosis.requestedQuoteMode,
          debugContext: 'ui:/api/runs/:id/source-data',
          hasHeader: savedDiagnosis.headerApplied,
        }
        : {
          debugContext: 'ui:/api/runs/:id/source-data',
        };
      const ir = await ingestFile(filePath, ingestOptions, Math.max(1, Math.min(limit, 500)));

      let totalCount = 0;
      const rows: Record<string, string>[] = [];
      for await (const chunk of ir.records) {
        for (const row of chunk) {
          if (totalCount >= offset && rows.length < limit) {
            rows.push(Object.fromEntries(
              ir.columns.map((column) => [column, row[column] ?? '']),
            ) as Record<string, string>);
          }
          totalCount++;
        }
      }

      res.json({
        columns: ir.columns,
        totalCount,
        offset,
        limit,
        rows,
        diagnosis: ir.diagnosis,
        parseFailures: ir.parseFailures,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Read failed' });
    }
  });

  // --- API: Duplicate groups (grouped view) ---
  app.get('/api/runs/:id/duplicates', async (req, res) => {
    const run = getRun(baseOutputDir, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const filePath = join(run.outputDir, 'duplicates.csv');
    if (!existsSync(filePath)) {
      return res.status(404).json({ error: 'No duplicates file' });
    }

    try {
      const { createReadStream } = await import('node:fs');
      const { parse: csvParse } = await import('csv-parse');

      const records: Record<string, string>[] = [];
      const stream = createReadStream(filePath).pipe(csvParse({ columns: true, skip_empty_lines: true, bom: true }));
      for await (const row of stream) records.push(row as Record<string, string>);

      // Group by group_id
      const groups = new Map<string, { matchType: string; matchKey: string; records: Record<string, string>[] }>();
      for (const rec of records) {
        const gid = rec.group_id || rec.groupId || '';
        if (!gid) continue;
        if (!groups.has(gid)) {
          groups.set(gid, {
            matchType: rec.match_type || rec.matchType || '',
            matchKey: rec.match_key || rec.matchKey || '',
            records: [],
          });
        }
        groups.get(gid)!.records.push(rec);
      }

      const result = Array.from(groups.entries()).map(([id, g]) => ({
        groupId: id,
        matchType: g.matchType,
        matchKey: g.matchKey,
        count: g.records.length,
        records: g.records,
      }));

      res.json({ totalGroups: result.length, groups: result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Read failed' });
    }
  });

  // --- API: Preview file ---
  app.get('/api/preview', async (req, res) => {
    const file = req.query.file as string;
    if (!file || !existsSync(file)) {
      return res.status(400).json({ error: 'file parameter required and must exist' });
    }

    const ingestOptions: IngestOptions = {
      encoding: (req.query.encoding as IngestOptions['encoding']) ?? 'auto',
      delimiter: (req.query.delimiter as IngestOptions['delimiter']) ?? 'auto',
      csvQuoteMode: (req.query.csvQuoteMode as IngestOptions['csvQuoteMode']) ?? 'auto',
      debugContext: 'ui:/api/preview',
      hasHeader: req.query.hasHeader !== 'false',
      previewRows: req.query.rows ? parseInt(String(req.query.rows), 10) : 100,
    };

    try {
      const { ingestFile } = await import('../io/file-reader.js');
      const { generateMappingSuggestions } = await import('../core/column-mapper.js');

      const ir = await ingestFile(file, ingestOptions, 5000);
      const sampleRows: Record<string, string>[] = [];
      for await (const chunk of ir.records) {
        for (const row of chunk) sampleRows.push(row);
      }

      const suggestions = generateMappingSuggestions(ir.schemaFingerprint, ir.columns);
      const parseErrorHelp = ir.parseFailures.length > 0
        ? {
          message: 'このCSVはそのまま読めない行がありました。',
          detail: '文字コードを切り替えるか、FileMaker からタブ区切りで出し直してください。',
          firstRow: ir.parseFailures[0]?.rowIndex ?? null,
        }
        : null;

      // Header detection: analyze first sample row as potential header
      const firstDataRow = sampleRows[0] ? Object.values(sampleRows[0]) : [];
      const headerDetection = detectHeaderLikelihood(firstDataRow);

      // Mojibake scan
      const mojibakeScan = scanForMojibake(sampleRows, 20);

      // File size
      let fileSize: number | null = null;
      try {
        const stats = await stat(file);
        fileSize = stats.size;
      } catch {
        // ignore
      }

      res.json({
        file,
        diagnosis: ir.diagnosis,
        sourceFileHash: ir.sourceFileHash,
        schemaFingerprint: ir.schemaFingerprint,
        columns: ir.columns,
        sampleRows,
        parseFailures: ir.parseFailures,
        parseErrorHelp,
        mappingSuggestions: suggestions.suggestions,
        headerDetection,
        mojibakeScan,
        fileSize,
      });
    } catch (err) {
      const userErr = toUserFacingCsvError(err);
      res.status(500).json({
        error: userErr.message,
        detail: userErr.detail,
        rawError: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // --- API: Upload and identify file (profile matching) ---
  app.post('/api/upload-identify', upload.single('file'), async (req, res) => {
    try {
      const uploaded = req.file as Express.Multer.File | undefined;
      if (!uploaded) {
        return res.status(400).json({ error: 'ファイルが指定されていません' });
      }

      const { renameSync } = await import('node:fs');
      const readableName = decodeUploadedFilename(uploaded.originalname);
      const dest = join(uploadDir, readableName);
      renameSync(uploaded.path, dest);

      // Parse optional encoding/hasHeader overrides
      const encoding = (req.body.encoding as IngestOptions['encoding']) ?? 'auto';
      const csvQuoteMode = (req.body.csvQuoteMode as IngestOptions['csvQuoteMode']) ?? 'auto';
      const hasHeader = req.body.hasHeader !== 'false';

      const { ingestFile } = await import('../io/file-reader.js');
      const ir = await ingestFile(dest, {
        encoding,
        csvQuoteMode,
        debugContext: 'ui:/api/upload-identify',
        hasHeader,
        previewRows: 10,
      }, 5000);
      const sampleRows: Record<string, string>[] = [];
      for await (const chunk of ir.records) {
        for (const row of chunk) {
          sampleRows.push(row);
          if (sampleRows.length >= 10) break;
        }
        if (sampleRows.length >= 10) break;
      }

      // ヘッダーなし CSV かどうかを判定（hasHeader=false で読み込んだ場合）
      const isHeaderless = ir.diagnosis.headerApplied === false;
      // 実際の列数（ヘッダーなしでも ingest 後に確定している）
      const actualColumnCount = ir.columns.length;
      const profileMatch = matchProfile(readableName, ir.columns, {
        isHeaderless,
        columnCount: actualColumnCount,
      });

      res.json({
        filename: readableName,
        filePath: dest,
        diagnosis: {
          detectedEncoding: ir.diagnosis.format === 'csv' ? ir.diagnosis.detectedEncoding : 'xlsx',
          appliedEncoding: ir.diagnosis.format === 'csv' ? ir.diagnosis.appliedEncoding : 'xlsx',
          headerApplied: ir.diagnosis.headerApplied,
          format: ir.diagnosis.format,
        },
        previewRows: sampleRows,
        columns: ir.columns,
        profileMatch,
        sourceFileHash: ir.sourceFileHash,
        schemaFingerprint: ir.schemaFingerprint,
      });
    } catch (err) {
      const userErr = toUserFacingCsvError(err);
      res.status(500).json({
        error: userErr.message,
        detail: userErr.detail,
        rawError: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // ===== Review API =====

  // --- API: Create review from a run ---
  app.post('/api/reviews', async (req, res) => {
    try {
      const { runId, fileIndex, configPath } = req.body;
      if (!runId) return res.status(400).json({ error: 'runId is required' });
      const config = loadConfig(configPath || undefined);
      config.outputDir = baseOutputDir;
      const review = await createReview(runId, baseOutputDir, config, fileIndex ?? 0);
      res.json(review);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to create review' });
    }
  });

  // --- API: List reviews ---
  app.get('/api/reviews', (_req, res) => {
    res.json(listReviews(baseOutputDir));
  });

  // --- API: Get review detail ---
  app.get('/api/reviews/:id', (req, res) => {
    const review = getReview(baseOutputDir, req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json(review);
  });

  // --- API: Update column reviews ---
  app.put('/api/reviews/:id/columns', (req, res) => {
    const updates = req.body;
    if (!Array.isArray(updates)) return res.status(400).json({ error: 'Expected array of column updates' });
    const review = updateReviewColumns(baseOutputDir, req.params.id, updates);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json(review);
  });

  // --- API: Update review summary ---
  app.put('/api/reviews/:id/summary', (req, res) => {
    const review = updateReviewSummary(baseOutputDir, req.params.id, req.body);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    res.json(review);
  });

  // --- API: Finalize review → generate bundle + copy to submitted ---
  app.post('/api/reviews/:id/finalize', async (req, res) => {
    try {
      const files = generateBundle(baseOutputDir, req.params.id);
      const review = getReview(baseOutputDir, req.params.id);
      if (review) {
        const { cpSync } = await import('node:fs');
        const srcDir = join(baseOutputDir, 'reviews', req.params.id);
        const destDir = join(submittedDir, req.params.id);
        mkdirSync(destDir, { recursive: true });
        cpSync(srcDir, destDir, { recursive: true });
      }
      res.json({ files, savedTo: submittedDir });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Bundle generation failed' });
    }
  });

  // --- API: List review output files ---
  app.get('/api/reviews/:id/files', (req, res) => {
    res.json(getReviewOutputFiles(baseOutputDir, req.params.id));
  });

  // --- API: Download review bundle file ---
  app.get('/api/reviews/:id/raw/:filename', (req, res) => {
    const review = getReview(baseOutputDir, req.params.id);
    if (!review) return res.status(404).json({ error: 'Review not found' });
    const dir = join(baseOutputDir, 'reviews', req.params.id);
    const filePath = join(dir, req.params.filename);
    if (!existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    res.sendFile(resolve(filePath));
  });

  // --- API: Delete review ---
  app.delete('/api/reviews/:id', (req, res) => {
    const deleted = deleteReviewBundle(baseOutputDir, req.params.id);
    if (!deleted) return res.status(404).json({ error: 'Review not found' });
    res.json({ ok: true });
  });

  // --- API: Server info (for admin display) ---
  app.get('/api/server-info', (_req, res) => {
    res.json({
      bundleDir: resolvedBundleDir,
      submittedDir,
      checkedDir,
      reworkDir,
      outputDir: baseOutputDir,
    });
  });

  // --- API: List all file profiles ---
  app.get('/api/profiles', (_req, res) => {
    res.json(getProfiles());
  });

  // --- API: Get single profile ---
  app.get('/api/profiles/:id', (req, res) => {
    const profile = getProfileById(req.params.id);
    if (!profile) return res.status(404).json({ error: 'プロファイルが見つかりません' });
    res.json(profile);
  });

  // --- API: Save/update a profile ---
  app.post('/api/profiles', (req, res) => {
    try {
      const profile = req.body as FileProfile;
      if (!profile.id || !profile.label) {
        return res.status(400).json({ error: 'id と label は必須です' });
      }
      const profiles = getProfiles();
      const idx = profiles.findIndex(p => p.id === profile.id);
      if (idx >= 0) {
        profiles[idx] = profile;
      } else {
        profiles.push(profile);
      }
      saveProfiles(baseOutputDir, profiles);
      res.json({ ok: true, profile });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存に失敗しました' });
    }
  });

  // --- API: Save column review ---
  app.post('/api/column-reviews/:runId/:profileId', (req, res) => {
    try {
      const { runId, profileId } = req.params;
      const reviews = req.body.reviews as ColumnReviewEntry[];
      if (!Array.isArray(reviews)) {
        return res.status(400).json({ error: 'reviews は配列で指定してください' });
      }

      const profileDef = profileId !== 'new' ? getProfileById(profileId)?.columns ?? null : null;
      const actualColumns = getRunColumnsForReview(runId);
      const reconciledReviews = reconcileColumnReviews(reviews, { actualColumns, profileDef });

      // 列レビューを保存
      saveColumnReview(baseOutputDir, runId, profileId, reconciledReviews);

      // 実効 mapping を生成して保存
      const effectiveResult = buildEffectiveMapping(runId, profileId, reconciledReviews, profileDef);
      saveEffectiveMapping(baseOutputDir, effectiveResult);

      res.json({
        ok: true,
        effectiveSummary: {
          activeCount: effectiveResult.activeCount,
          unusedCount: effectiveResult.unusedCount,
          pendingCount: effectiveResult.pendingCount,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存に失敗しました' });
    }
  });

  // --- API: Load column review ---
  app.get('/api/column-reviews/:runId/:profileId', (req, res) => {
    const { runId, profileId } = req.params;
    const reviews = loadColumnReview(baseOutputDir, runId, profileId);
    if (!reviews) return res.json({ reviews: null });
    res.json({ reviews });
  });

  // --- API: Get effective mapping for a run + profile ---
  app.get('/api/column-reviews/:runId/:profileId/effective', (req, res) => {
    const { runId, profileId } = req.params;
    const result = loadEffectiveMapping(baseOutputDir, runId, profileId);
    if (!result) return res.status(404).json({ error: '実効 mapping が見つかりません' });
    res.json(result);
  });

  // --- API: Get column review status for a run (all saved profiles) ---
  app.get('/api/runs/:id/column-status', (req, res) => {
    const runId = req.params.id;
    const mappings = findEffectiveMappings(baseOutputDir, runId);
    if (mappings.length === 0) return res.json({ entries: [] });

    const entries = mappings.map(m => {
      const profile = m.profileId !== 'new' ? getProfileById(m.profileId) : null;
      return {
        profileId: m.profileId,
        profileName: profile?.label ?? (m.profileId === 'new' ? '新規ファイル' : m.profileId),
        activeCount: m.activeCount,
        unusedCount: m.unusedCount,
        pendingCount: m.pendingCount,
        generatedAt: m.generatedAt,
        columns: m.columns,
      };
    });
    res.json({ entries });
  });

  // --- API: Re-run normalize with saved column review mapping ---
  app.post('/api/runs/:id/rerun-with-review', async (req, res) => {
    try {
      const original = getRun(baseOutputDir, req.params.id);
      if (!original) return res.status(404).json({ error: 'Run が見つかりません' });

      const { profileId } = req.body as { profileId?: string };
      if (!profileId) {
        return res.status(400).json({ error: 'profileId が必要です' });
      }

      const profileDef = profileId !== 'new' ? getProfileById(profileId)?.columns ?? null : null;
      const savedReviews = loadColumnReview(baseOutputDir, req.params.id, profileId);
      if (!savedReviews) {
        return res.status(404).json({
          error: '列レビューの回答が見つかりません。先に列の回答を保存してください。',
        });
      }
      const actualColumns = original.inputColumns?.[original.inputFiles[0] ?? ''] ?? original.columnNames ?? [];
      const reconciledReviews = reconcileColumnReviews(savedReviews, { actualColumns, profileDef });
      saveColumnReview(baseOutputDir, req.params.id, profileId, reconciledReviews);
      const effectiveResult = buildEffectiveMapping(req.params.id, profileId, reconciledReviews, profileDef);
      saveEffectiveMapping(baseOutputDir, effectiveResult);

      const configPath = original.configPath || undefined;
      const config = loadConfig(configPath);
      config.outputDir = baseOutputDir;

      // 実効 mapping を渡して normalize 実行
      const meta = await executeRun(
        'normalize',
        original.inputFiles,
        config,
        configPath,
        { effectiveMapping: effectiveResult.mapping, profileId },
      );
      res.json(meta);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '実行に失敗しました' });
    }
  });

  // --- API: 列レビューから candidate profile を生成・保存 ---
  app.post('/api/runs/:id/save-candidate-profile', async (req, res) => {
    try {
      const runId = req.params.id;
      const { profileId, label } = req.body as { profileId?: string; label?: string };
      if (!profileId) {
        return res.status(400).json({ error: 'profileId が必要です' });
      }

      const run = getRun(baseOutputDir, runId);
      if (!run) return res.status(404).json({ error: 'Run が見つかりません' });

      const em = loadEffectiveMapping(baseOutputDir, runId, profileId);
      if (!em) {
        return res.status(404).json({
          error: '列レビューの回答が見つかりません。先に列の確認を保存してください。',
        });
      }

      // 元ファイル名を basename で取得
      const sourceFilename = run.inputFiles.length > 0
        ? run.inputFiles[0].split('/').pop() ?? 'unknown.csv'
        : 'unknown.csv';

      const candidate = buildCandidateProfile(runId, sourceFilename, em, { label });
      saveCandidateProfile(baseOutputDir, candidate);

      // registry を更新（次回の matchProfile に反映）
      loadProfiles(baseOutputDir);

      res.json({ id: candidate.id, label: candidate.label, saved: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '保存に失敗しました' });
    }
  });

  // --- API: Fast path — known file を列レビューなしで進める ---
  app.post('/api/runs/:id/fast-path', async (req, res) => {
    try {
      const runId = req.params.id;
      const { profileId, columns } = req.body as { profileId?: string; columns?: string[] };

      if (!profileId) {
        return res.status(400).json({ error: 'profileId が必要です' });
      }

      const original = getRun(baseOutputDir, runId);
      if (!original) return res.status(404).json({ error: 'Run が見つかりません' });

      const profile = profileId !== 'new' ? getProfileById(profileId) : null;
      if (!profile) {
        return res.status(400).json({ error: 'fast path はプロファイルが必要です' });
      }

      // profile の列定義から自動レビューを生成（全て inUse=yes）
      const actualColumns = getRunColumnsForReview(runId).length > 0
        ? getRunColumnsForReview(runId)
        : Array.isArray(columns) ? columns : [];
      const autoReviews = reconcileColumnReviews(
        buildAutoReviews(profile.columns, actualColumns),
        { actualColumns, profileDef: profile.columns },
      );

      // 列レビューを保存
      saveColumnReview(baseOutputDir, runId, profileId, autoReviews);

      // 実効 mapping を生成して保存
      const effectiveResult = buildEffectiveMapping(runId, profileId, autoReviews, profile.columns);
      saveEffectiveMapping(baseOutputDir, effectiveResult);

      // fast path で進んだことを run meta に記録
      patchRunMeta(baseOutputDir, runId, {
        usedFastPath: true,
        fastPathProfileId: profileId,
        skippedColumnReview: true,
      });

      // rerun-with-review と同じロジックで normalize を再実行
      const configPath = original.configPath || undefined;
      const config = loadConfig(configPath);
      config.outputDir = baseOutputDir;

      const meta = await executeRun(
        'normalize',
        original.inputFiles,
        config,
        configPath,
        { effectiveMapping: effectiveResult.mapping, profileId },
      );

      res.json({
        ok: true,
        runId: meta.id,
        effectiveSummary: {
          activeCount: effectiveResult.activeCount,
          unusedCount: effectiveResult.unusedCount,
          pendingCount: effectiveResult.pendingCount,
        },
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : '実行に失敗しました' });
    }
  });

  // --- API: List config files ---
  app.get('/api/configs', (_req, res) => {
    const cwd = process.cwd();
    const configs: string[] = [];
    const candidates = ['workbench.config.json', 'workbench.config.sample.json'];
    for (const c of candidates) {
      if (existsSync(join(cwd, c))) configs.push(c);
    }
    res.json(configs);
  });

  // --- API: Auto-apply preview ---
  app.post('/api/auto-apply-preview', (req, res) => {
    const { columns, encoding, hasHeader } = req.body as {
      columns: unknown;
      encoding?: string;
      hasHeader?: boolean;
    };
    if (!Array.isArray(columns)) {
      res.status(400).json({ error: 'columns は配列で指定してください' });
      return;
    }
    const schemaFP = computeSchemaFingerprint(columns as string[]);
    const result = runAutoApplyPreview(
      columns as string[],
      encoding ?? 'cp932',
      hasHeader ?? true,
      schemaFP,
      baseOutputDir,
    );
    res.json(result);
  });

  // --- API: Import preview (file upload → auto-apply + column samples) ---
  app.post('/api/import-preview', upload.single('file'), async (req, res) => {
    const uploaded = req.file as Express.Multer.File | undefined;
    if (!uploaded) {
      res.status(400).json({ error: 'ファイルが指定されていません' });
      return;
    }
    try {
      const { renameSync } = await import('node:fs');
      const fileName = decodeUploadedFilename(uploaded.originalname);
      const dest = join(uploadDir, fileName);
      renameSync(uploaded.path, dest);

      const { runImportPreview } = await import('../core/import-preview.js');
      const result = await runImportPreview(dest, fileName, baseOutputDir);
      res.json(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  const VALID_RESOLUTION_TYPES = new Set([
    'shared_phone', 'phone_exception', 'status_meaning',
    'customer_deal_boundary', 'parent_child_classification',
    'column_ignore', 'encoding_exception', 'merge_policy',
    'column_canonical',
  ]);
  app.post('/api/decisions/resolutions', (req, res) => {
    const record = req.body as Partial<ResolutionRecord>;
    if (!record.resolution_id || !record.resolution_type || !record.context_key) {
      res
        .status(400)
        .json({ error: 'resolution_id, resolution_type, context_key は必須です' });
      return;
    }
    if (!VALID_RESOLUTION_TYPES.has(record.resolution_type as string)) {
      res.status(400).json({ error: '不正な resolution_type です' });
      return;
    }
    let memory = loadMemory(baseOutputDir);
    memory = addResolution(record as ResolutionRecord, memory);
    saveMemory(memory, baseOutputDir);
    res.json({ ok: true, resolutionId: record.resolution_id });
  });

  return app;
}

// Start server when run directly
const port = parseInt(process.env.PORT ?? '3456', 10);
const host = process.env.HOST ?? '0.0.0.0';
const outputDir = process.env.OUTPUT_DIR ?? './output';
const bundleDir = process.env.BUNDLE_DIR || undefined;
mkdirSync(outputDir, { recursive: true });

const app = createApp(resolve(outputDir), bundleDir ? resolve(bundleDir) : undefined);
app.listen(port, host, () => {
  const lanNote = host === '0.0.0.0'
    ? '  LAN: http://<このPCのIPアドレス>:' + port
    : '';
  console.log(`\n  FileMaker Data Workbench UI`);
  console.log(`  Local: http://localhost:${port}`);
  if (lanNote) console.log(lanNote);
  console.log(`\n  Output:  ${resolve(outputDir)}`);
  if (bundleDir) console.log(`  Bundles: ${resolve(bundleDir)}`);
  else console.log(`  Bundles: ${resolve(outputDir)}/review-bundles`);
  console.log(`  Press Ctrl+C to stop\n`);
});
