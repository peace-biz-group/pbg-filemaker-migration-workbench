#!/usr/bin/env node

/**
 * Local-only review UI server.
 * Express + static HTML. No auth, no cloud, no external deps beyond express.
 */

import express from 'express';
import multer from 'multer';
import { resolve, join, extname } from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../config/defaults.js';
import { executeRun, listRuns, getRun, getRunOutputFiles, deleteRun, getRunEmitter } from '../core/pipeline-runner.js';
import type { RunMode, ProgressEvent } from '../core/pipeline-runner.js';
import type { IngestOptions } from '../ingest/ingest-options.js';
import {
  createReview, listReviews, getReview, updateReviewColumns,
  updateReviewSummary, deleteReview as deleteReviewBundle,
  getReviewOutputFiles, generateBundle,
} from '../core/review-bundle.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const VALID_MODES: RunMode[] = ['profile', 'normalize', 'detect-duplicates', 'classify', 'run-all', 'run-batch'];

export function createApp(baseOutputDir: string) {
  const app = express();
  app.use(express.json());

  // Static files
  app.use('/static', express.static(join(__dirname, 'public')));

  // Upload temp dir
  const uploadDir = join(baseOutputDir, '.uploads');
  mkdirSync(uploadDir, { recursive: true });
  const upload = multer({ dest: uploadDir });

  // --- Pages (serve index.html for all page routes) ---
  const indexHtml = join(__dirname, 'public', 'index.html');
  const spaRoutes = [
    '/', '/new', '/runs/:id',
    '/reviews/new', '/reviews/:id', '/reviews/:id/columns', '/reviews/:id/summary',
  ];
  for (const route of spaRoutes) {
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
          const dest = join(uploadDir, f.originalname);
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
      const { createReadStream } = await import('node:fs');
      const { parse: csvParse } = await import('csv-parse');

      // Count total
      let totalCount = 0;
      const countStream = createReadStream(filePath).pipe(csvParse({ columns: true, skip_empty_lines: true, bom: true }));
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      for await (const _row of countStream) totalCount++;

      // Read slice
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

      res.json({
        file,
        diagnosis: ir.diagnosis,
        sourceFileHash: ir.sourceFileHash,
        schemaFingerprint: ir.schemaFingerprint,
        columns: ir.columns,
        sampleRows,
        parseFailures: ir.parseFailures,
        mappingSuggestions: suggestions.suggestions,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Preview failed' });
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

  // --- API: Finalize review → generate bundle ---
  app.post('/api/reviews/:id/finalize', (req, res) => {
    try {
      const files = generateBundle(baseOutputDir, req.params.id);
      res.json({ files });
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

  return app;
}

// Start server when run directly
const port = parseInt(process.env.PORT ?? '3456', 10);
const outputDir = process.env.OUTPUT_DIR ?? './output';
mkdirSync(outputDir, { recursive: true });

const app = createApp(resolve(outputDir));
app.listen(port, () => {
  console.log(`\n  FileMaker Data Workbench UI`);
  console.log(`  http://localhost:${port}\n`);
  console.log(`  Output: ${resolve(outputDir)}`);
  console.log(`  Press Ctrl+C to stop\n`);
});
