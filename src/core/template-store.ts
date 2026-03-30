// src/core/template-store.ts

import { mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { schemaFingerprint } from '../ingest/fingerprint.js';
import { normalizeFilename, filenameSimilarity } from './filename-matcher.js';
import type { FileTemplate, TemplateMatch, TemplateMatchReason } from '../types/index.js';

/** Directory for templates relative to outputDir */
const TEMPLATES_SUBDIR = '.templates';

function templatesDir(outputDir: string): string {
  return join(outputDir, TEMPLATES_SUBDIR);
}

function templatePath(outputDir: string, id: string): string {
  return join(templatesDir(outputDir), `${id}.json`);
}

/** Ensure the templates directory exists. */
function ensureTemplatesDir(outputDir: string): void {
  mkdirSync(templatesDir(outputDir), { recursive: true });
}

/** Save or update a template. */
export function saveTemplate(outputDir: string, template: FileTemplate): void {
  ensureTemplatesDir(outputDir);
  writeFileSync(templatePath(outputDir, template.id), JSON.stringify(template, null, 2), 'utf8');
}

/** Load a template by ID. Returns null if not found. */
export function loadTemplate(outputDir: string, id: string): FileTemplate | null {
  const path = templatePath(outputDir, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FileTemplate;
  } catch {
    return null;
  }
}

/** List all templates. Returns [] if directory doesn't exist. */
export function listTemplates(outputDir: string): FileTemplate[] {
  const dir = templatesDir(outputDir);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
  const templates: FileTemplate[] = [];
  for (const file of files) {
    try {
      const raw = readFileSync(join(dir, file), 'utf8');
      templates.push(JSON.parse(raw) as FileTemplate);
    } catch {
      // skip malformed template files
    }
  }
  return templates;
}

/** Delete a template by ID. Returns true if deleted, false if not found. */
export function deleteTemplate(outputDir: string, id: string): boolean {
  const path = templatePath(outputDir, id);
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}

/**
 * Find templates matching the given file characteristics.
 * Returns up to 3 matches with score >= 0.3, sorted by score descending.
 *
 * Scoring weights:
 *   - schemaFingerprint exact match: +0.50
 *   - column name Jaccard similarity: +0.20
 *   - filename similarity (max across knownFilenamePatterns): +0.15
 *   - column count match: +0.10 (scaled: 1.0 for exact, 0.5 for ±1, 0 for ±5+)
 *   - encoding match: +0.03
 *   - header match: +0.02
 */
export function findMatchingTemplates(
  outputDir: string,
  filename: string,
  columns: string[],
  encoding: string,
  hasHeader: boolean,
): TemplateMatch[] {
  const templates = listTemplates(outputDir);
  if (templates.length === 0) return [];

  const inputFingerprint = schemaFingerprint(columns);
  const normalizedInput = normalizeFilename(filename);
  const inputColumnsLower = new Set(columns.map((c) => c.toLowerCase()));

  const matches: TemplateMatch[] = [];

  for (const template of templates) {
    const reasons: TemplateMatchReason[] = [];
    let score = 0;

    // Schema fingerprint exact match: +0.50
    const fingerprintContribution = template.schemaFingerprint === inputFingerprint ? 0.50 : 0;
    if (fingerprintContribution > 0) {
      score += fingerprintContribution;
      reasons.push({
        factor: 'schema_fingerprint',
        description: '前に使った列と同じです',
        contribution: fingerprintContribution,
      });
    }

    // Column name Jaccard similarity: +0.20
    const templateColumnsLower = new Set(template.columnNames.map((c) => c.toLowerCase()));
    let intersectionCount = 0;
    for (const col of inputColumnsLower) {
      if (templateColumnsLower.has(col)) intersectionCount++;
    }
    const unionCount = new Set([...inputColumnsLower, ...templateColumnsLower]).size;
    const jaccard = unionCount > 0 ? intersectionCount / unionCount : 0;
    const columnOverlapContribution = jaccard * 0.20;
    if (columnOverlapContribution > 0) {
      score += columnOverlapContribution;
      if (jaccard > 0.3) {
        reasons.push({
          factor: 'column_overlap',
          description: '前に使った形と似ています',
          contribution: columnOverlapContribution,
        });
      }
    }

    // Filename similarity: +0.15
    let filenameSim = 0;
    if (template.knownFilenamePatterns.length > 0) {
      filenameSim = Math.max(
        ...template.knownFilenamePatterns.map((p) => filenameSimilarity(normalizedInput, p)),
      );
    }
    const filenameContribution = filenameSim * 0.15;
    if (filenameContribution > 0) {
      score += filenameContribution;
      if (filenameSim > 0.3) {
        reasons.push({
          factor: 'filename',
          description: 'ファイル名が近いです',
          contribution: filenameContribution,
        });
      }
    }

    // Column count match: +0.10
    const diff = Math.abs(template.columnCount - columns.length);
    const columnCountScore = diff === 0 ? 1.0 : diff === 1 ? 0.5 : Math.max(0, 1 - diff / 5);
    const columnCountContribution = columnCountScore * 0.10;
    if (columnCountContribution > 0) {
      score += columnCountContribution;
      if (columnCountScore > 0.5) {
        reasons.push({
          factor: 'column_count',
          description: '列の数が近いです',
          contribution: columnCountContribution,
        });
      }
    }

    // Encoding match: +0.03
    const encodingContribution = template.defaultEncoding === encoding ? 0.03 : 0;
    if (encodingContribution > 0) {
      score += encodingContribution;
      reasons.push({
        factor: 'encoding',
        description: '文字コードが同じです',
        contribution: encodingContribution,
      });
    }

    // Header match: +0.02
    const headerContribution = template.hasHeader === hasHeader ? 0.02 : 0;
    if (headerContribution > 0) {
      score += headerContribution;
      reasons.push({
        factor: 'header',
        description: 'ヘッダの形が同じです',
        contribution: headerContribution,
      });
    }

    if (score >= 0.3) {
      matches.push({ template, score, reasons });
    }
  }

  matches.sort((a, b) => b.score - a.score);
  return matches.slice(0, 3);
}
