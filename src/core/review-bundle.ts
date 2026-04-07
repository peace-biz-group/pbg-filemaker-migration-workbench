/**
 * Review bundle manager — CRUD for review state + bundle output generation.
 * Reviews are stored under {outputDir}/reviews/{reviewId}/.
 * All outputs are proposals/candidates, never canonical.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';
import { profileFile } from './profiler.js';
import { suggestAllColumns, suggestFileType } from './suggestion-engine.js';
import type { WorkbenchConfig } from '../config/schema.js';
import type {
  ReviewMeta,
  ColumnReview,
  MappingProposalEntry,
  SectionLayoutEntry,
  FileType,
  FieldFamily,
  Section,
  ReviewStatus,
} from '../types/review.js';
import { getRun } from './pipeline-runner.js';
import { loadMemory, lookupResolution, shouldAutoApply } from './resolution-memory.js';
import { loadRegistry, getTemplate } from './mapping-template-registry.js';

// --- Hashing ---

export function computeFileHash(filePath: string): string {
  const content = readFileSync(filePath);
  return createHash('sha256').update(content).digest('hex');
}

export function computeSchemaFingerprint(columnNames: string[]): string {
  const normalized = columnNames.map((c) => c.toLowerCase().trim()).sort().join('\0');
  return createHash('sha256').update(normalized).digest('hex');
}

// --- Directory helpers ---

function getReviewsBaseDir(outputDir: string): string {
  return join(outputDir, 'reviews');
}

function generateReviewId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
  return `rev_${ts}_${rand}`;
}

function saveMeta(review: ReviewMeta, outputDir: string): void {
  const dir = join(getReviewsBaseDir(outputDir), review.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'review-meta.json'), JSON.stringify(review, null, 2), 'utf-8');
}

// --- Resolution memory integration ---

export function applyColumnIgnoreResolutions(
  columns: ColumnReview[],
  outputDir: string,
): ColumnReview[] {
  const memory = loadMemory(outputDir);
  return columns.map((col) => {
    const res = lookupResolution('column_ignore', `column:${col.sourceColumn}`, memory);
    if (res && shouldAutoApply(res) && res.decision === 'unused' && col.decision === 'unknown') {
      return { ...col, decision: 'unused' as const };
    }
    return col;
  });
}

// --- Template pre-fill ---

export function applyTemplateToColumns(
  columns: ColumnReview[],
  schemaFP: string,
  outputDir: string,
): ColumnReview[] {
  const registry = loadRegistry(outputDir);
  const template = getTemplate(schemaFP, registry);
  if (!template) return columns;

  const decisionMap = new Map(template.column_decisions.map((d) => [d.source_col, d]));

  return columns.map((col) => {
    // Don't overwrite existing human decisions
    if (col.decision !== 'unknown') return col;

    const d = decisionMap.get(col.sourceColumn);
    if (!d || d.confidence === 'low') return col;

    if (d.canonical_field === null) {
      return { ...col, decision: 'unused' as const };
    }
    return { ...col, humanSemanticField: d.canonical_field, decision: 'accepted' as const };
  });
}

// --- CRUD ---

export async function createReview(
  runId: string,
  outputDir: string,
  config: WorkbenchConfig,
  fileIndex = 0,
): Promise<ReviewMeta> {
  const run = getRun(outputDir, runId);
  if (!run) throw new Error(`Run not found: ${runId}`);
  if (run.status !== 'completed') throw new Error(`Run is not completed: ${runId}`);

  const filePath = run.inputFiles[fileIndex];
  if (!filePath || !existsSync(filePath)) {
    throw new Error(`Input file not found: ${filePath}`);
  }

  // Profile the file to get column info
  const profile = await profileFile(filePath, config);

  // Compute hashes
  const sourceFileHash = computeFileHash(filePath);
  const schemaFingerprint = computeSchemaFingerprint(profile.columns.map((c) => c.name));

  // Generate suggestions, applying any persisted column_ignore resolutions and template pre-fill
  const columns = applyTemplateToColumns(
    applyColumnIgnoreResolutions(
      suggestAllColumns(profile.columns, config, filePath),
      outputDir,
    ),
    schemaFingerprint,
    outputDir,
  );

  // Suggest file type
  const fileTypeSuggestion = suggestFileType(columns);

  const now = new Date().toISOString();
  const review: ReviewMeta = {
    id: generateReviewId(),
    runId,
    fileName: basename(filePath),
    sourceFileHash,
    schemaFingerprint,
    createdAt: now,
    updatedAt: now,
    reviewStatus: 'draft',
    columns,
    primaryFileType: fileTypeSuggestion.fileType as FileType,
    mixedFamilies: [],
    reviewer: '',
    notes: '',
  };

  saveMeta(review, outputDir);
  return review;
}

export function listReviews(outputDir: string): ReviewMeta[] {
  const reviewsDir = getReviewsBaseDir(outputDir);
  if (!existsSync(reviewsDir)) return [];

  const entries = readdirSync(reviewsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()
    .reverse();

  const reviews: ReviewMeta[] = [];
  for (const dir of entries) {
    const metaPath = join(reviewsDir, dir, 'review-meta.json');
    if (existsSync(metaPath)) {
      try {
        reviews.push(JSON.parse(readFileSync(metaPath, 'utf-8')));
      } catch {
        // skip corrupted
      }
    }
  }
  return reviews;
}

export function getReview(outputDir: string, reviewId: string): ReviewMeta | null {
  const metaPath = join(getReviewsBaseDir(outputDir), reviewId, 'review-meta.json');
  if (!existsSync(metaPath)) return null;
  return JSON.parse(readFileSync(metaPath, 'utf-8'));
}

export function updateReviewColumns(
  outputDir: string,
  reviewId: string,
  columnUpdates: Array<{
    sourceColumn: string;
    humanSemanticField: string | null;
    humanFieldFamily: FieldFamily | null;
    humanSection: Section | null;
    decision: string;
  }>,
): ReviewMeta | null {
  const review = getReview(outputDir, reviewId);
  if (!review) return null;

  for (const update of columnUpdates) {
    const col = review.columns.find((c) => c.sourceColumn === update.sourceColumn);
    if (col) {
      col.humanSemanticField = update.humanSemanticField;
      col.humanFieldFamily = update.humanFieldFamily;
      col.humanSection = update.humanSection;
      col.decision = update.decision as ColumnReview['decision'];
    }
  }
  review.updatedAt = new Date().toISOString();
  saveMeta(review, outputDir);
  return review;
}

export function updateReviewSummary(
  outputDir: string,
  reviewId: string,
  updates: {
    primaryFileType?: FileType;
    mixedFamilies?: FieldFamily[];
    reviewer?: string;
    notes?: string;
    reviewStatus?: ReviewStatus;
  },
): ReviewMeta | null {
  const review = getReview(outputDir, reviewId);
  if (!review) return null;

  if (updates.primaryFileType !== undefined) review.primaryFileType = updates.primaryFileType;
  if (updates.mixedFamilies !== undefined) review.mixedFamilies = updates.mixedFamilies;
  if (updates.reviewer !== undefined) review.reviewer = updates.reviewer;
  if (updates.notes !== undefined) review.notes = updates.notes;
  if (updates.reviewStatus !== undefined) review.reviewStatus = updates.reviewStatus;
  review.updatedAt = new Date().toISOString();
  saveMeta(review, outputDir);
  return review;
}

export function deleteReview(outputDir: string, reviewId: string): boolean {
  const dir = join(getReviewsBaseDir(outputDir), reviewId);
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

export function getReviewOutputFiles(outputDir: string, reviewId: string): string[] {
  const dir = join(getReviewsBaseDir(outputDir), reviewId);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f !== 'review-meta.json').sort();
}

// --- Bundle generation ---

function effectiveSemanticField(col: ColumnReview): string {
  return col.humanSemanticField ?? col.suggestion.semanticField;
}

function effectiveFamily(col: ColumnReview): FieldFamily {
  return col.humanFieldFamily ?? col.suggestion.fieldFamily;
}

function effectiveSection(col: ColumnReview): Section {
  return col.humanSection ?? col.suggestion.section;
}

export function generateBundle(outputDir: string, reviewId: string): string[] {
  const review = getReview(outputDir, reviewId);
  if (!review) throw new Error(`Review not found: ${reviewId}`);

  const dir = join(getReviewsBaseDir(outputDir), reviewId);
  const generatedFiles: string[] = [];

  // 1. human-review.json — full review data
  const humanReviewPath = join(dir, 'human-review.json');
  writeFileSync(humanReviewPath, JSON.stringify(review, null, 2), 'utf-8');
  generatedFiles.push('human-review.json');

  // 2. mapping-proposal.json — config.columnMappings compatible
  const mappingEntries: MappingProposalEntry[] = [];
  const mapping: Record<string, string> = {};
  const unmapped: string[] = [];
  const unused: string[] = [];

  for (const col of review.columns) {
    const entry: MappingProposalEntry = {
      sourceColumn: col.sourceColumn,
      proposedCanonical: effectiveSemanticField(col),
      fieldFamily: effectiveFamily(col),
      section: effectiveSection(col),
      decision: col.decision,
      isHumanOverride: col.humanSemanticField !== null &&
        col.humanSemanticField !== col.suggestion.semanticField,
    };
    mappingEntries.push(entry);

    if (col.decision === 'accepted' || col.decision === 'adjusted') {
      mapping[col.sourceColumn] = effectiveSemanticField(col);
    } else if (col.decision === 'unused') {
      unused.push(col.sourceColumn);
    } else {
      unmapped.push(col.sourceColumn);
    }
  }

  const mappingProposal = {
    fileName: review.fileName,
    sourceFileHash: review.sourceFileHash,
    schemaFingerprint: review.schemaFingerprint,
    generatedAt: new Date().toISOString(),
    reviewer: review.reviewer,
    reviewStatus: review.reviewStatus,
    mapping,
    entries: mappingEntries,
    unmapped,
    unused,
  };
  writeFileSync(join(dir, 'mapping-proposal.json'), JSON.stringify(mappingProposal, null, 2), 'utf-8');
  generatedFiles.push('mapping-proposal.json');

  // 3. section-layout-proposal.json
  const sectionMap = new Map<Section, string[]>();
  for (const col of review.columns) {
    if (col.decision === 'unused') continue;
    const section = effectiveSection(col);
    if (!sectionMap.has(section)) sectionMap.set(section, []);
    sectionMap.get(section)!.push(col.sourceColumn);
  }
  const sections: SectionLayoutEntry[] = Array.from(sectionMap.entries())
    .map(([section, columns]) => ({ section, columns }));

  const sectionLayout = {
    primaryFileType: review.primaryFileType,
    mixedFamilies: review.mixedFamilies,
    schemaFingerprint: review.schemaFingerprint,
    generatedAt: new Date().toISOString(),
    sections,
  };
  writeFileSync(join(dir, 'section-layout-proposal.json'), JSON.stringify(sectionLayout, null, 2), 'utf-8');
  generatedFiles.push('section-layout-proposal.json');

  // 4. summary.md
  const md = generateSummaryMarkdown(review);
  writeFileSync(join(dir, 'summary.md'), md, 'utf-8');
  generatedFiles.push('summary.md');

  return generatedFiles;
}

function generateSummaryMarkdown(review: ReviewMeta): string {
  const lines: string[] = [];
  lines.push(`# Review Summary — ${review.fileName}`);
  lines.push('');
  lines.push(`- **Review ID**: ${review.id}`);
  lines.push(`- **Run ID**: ${review.runId}`);
  lines.push(`- **Reviewer**: ${review.reviewer || '（未入力）'}`);
  lines.push(`- **Status**: ${review.reviewStatus}`);
  lines.push(`- **Primary File Type**: ${review.primaryFileType || '（未選択）'}`);
  if (review.mixedFamilies.length > 0) {
    lines.push(`- **Mixed Families**: ${review.mixedFamilies.join(', ')}`);
  }
  lines.push(`- **Source File Hash**: \`${review.sourceFileHash.slice(0, 16)}...\``);
  lines.push(`- **Schema Fingerprint**: \`${review.schemaFingerprint.slice(0, 16)}...\``);
  lines.push(`- **Created**: ${review.createdAt}`);
  lines.push(`- **Updated**: ${review.updatedAt}`);
  lines.push('');

  // Column summary table
  lines.push('## Column Review');
  lines.push('');
  lines.push('| # | Source Column | Suggested | Human | Family | Section | Decision |');
  lines.push('|---|---|---|---|---|---|---|');
  review.columns.forEach((col, i) => {
    const suggested = col.suggestion.semanticField;
    const human = col.humanSemanticField ?? '—';
    const family = effectiveFamily(col);
    const section = effectiveSection(col);
    const diffMark = (col.humanSemanticField && col.humanSemanticField !== suggested) ? ' *' : '';
    lines.push(`| ${i + 1} | ${col.sourceColumn} | ${suggested} | ${human}${diffMark} | ${family} | ${section} | ${col.decision} |`);
  });
  lines.push('');

  // Diff section
  const diffs = review.columns.filter(
    (c) => c.humanSemanticField !== null && c.humanSemanticField !== c.suggestion.semanticField,
  );
  if (diffs.length > 0) {
    lines.push('## Differences (Suggestion vs Human)');
    lines.push('');
    for (const col of diffs) {
      lines.push(`- **${col.sourceColumn}**: ${col.suggestion.semanticField} → ${col.humanSemanticField}`);
    }
    lines.push('');
  }

  // Unknown / unused
  const unknownCols = review.columns.filter((c) => c.decision === 'unknown');
  const unusedCols = review.columns.filter((c) => c.decision === 'unused');

  if (unknownCols.length > 0) {
    lines.push('## Unknown Columns');
    lines.push('');
    for (const col of unknownCols) {
      lines.push(`- ${col.sourceColumn}`);
    }
    lines.push('');
  }

  if (unusedCols.length > 0) {
    lines.push('## Unused Columns');
    lines.push('');
    for (const col of unusedCols) {
      lines.push(`- ${col.sourceColumn}`);
    }
    lines.push('');
  }

  if (review.notes) {
    lines.push('## Notes');
    lines.push('');
    lines.push(review.notes);
    lines.push('');
  }

  lines.push('---');
  lines.push('*This is a proposal/candidate document. Not canonical.*');
  lines.push('');

  return lines.join('\n');
}
