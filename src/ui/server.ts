#!/usr/bin/env node

/**
 * Local-only review UI server.
 * Express + static HTML. No auth, no cloud, no external deps beyond express.
 */

import express from 'express';
import multer from 'multer';
import { resolve, join, extname } from 'node:path';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'csv-parse/sync';
import { loadConfig } from '../config/defaults.js';
import { executeRun, listRuns, getRun, getRunOutputFiles } from '../core/pipeline-runner.js';
import type { RunMode } from '../core/pipeline-runner.js';

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
  for (const route of ['/', '/new', '/runs/:id']) {
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

  // --- API: Read CSV data from a run's output file (paginated) ---
  app.get('/api/runs/:id/data/:filename', (req, res) => {
    const run = getRun(baseOutputDir, req.params.id);
    if (!run) return res.status(404).json({ error: 'Run not found' });

    const filePath = join(run.outputDir, req.params.filename);
    if (!existsSync(filePath) || extname(filePath) !== '.csv') {
      return res.status(404).json({ error: 'File not found' });
    }

    const offset = parseInt(String(req.query.offset ?? '0'), 10);
    const limit = Math.min(parseInt(String(req.query.limit ?? '100'), 10), 500);

    try {
      const content = readFileSync(filePath, 'utf-8');
      const records = parse(content, { columns: true, skip_empty_lines: true, bom: true }) as Record<string, string>[];
      const columns = records.length > 0 ? Object.keys(records[0]) : [];
      const page = records.slice(offset, offset + limit);

      res.json({
        columns,
        totalCount: records.length,
        offset,
        limit,
        rows: page,
      });
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

      // Collect input file paths
      let inputFiles: string[] = [];

      // Files uploaded via multipart
      const uploaded = req.files as Express.Multer.File[] | undefined;
      if (uploaded && uploaded.length > 0) {
        inputFiles = uploaded.map((f) => f.path);
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
