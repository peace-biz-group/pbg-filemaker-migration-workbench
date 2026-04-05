import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { parse as parseCsvSync } from 'csv-parse/sync';
import { writeCsv } from '../io/csv-writer.js';
import type {
  CountReconciliationSummary,
  FinalDisposition,
  HandoffArtifactView,
  HandoffBundleSummary,
  NextActionView,
  ParentExtractionClassification,
  RawRecord,
} from '../types/index.js';

const MAINLINE_HANDOFF_DISPOSITIONS: FinalDisposition[] = ['mainline_ready', 'inserted', 'updated', 'unchanged', 'duplicate'];
const REVIEW_PACK_DISPOSITIONS: FinalDisposition[] = ['review', 'archive_only'];
const QUARANTINE_PACK_DISPOSITIONS: FinalDisposition[] = ['quarantine'];
const ALL_PACK_PARENT_BUCKETS: ParentExtractionClassification[] = ['not_applicable', 'parent_candidate', 'ambiguous_parent', 'child_continuation'];
const ALL_FINAL_DISPOSITIONS: FinalDisposition[] = ['mainline_ready', 'review', 'archive_only', 'quarantine', 'inserted', 'updated', 'unchanged', 'duplicate'];

interface HandoffBundleInput {
  outputDir: string;
  normalizedPath: string;
  quarantinePath: string;
  reconciliation: CountReconciliationSummary;
  recordCount: number;
}

interface HandoffBundleResult {
  summary: HandoffBundleSummary;
  nextActionView: NextActionView;
  generatedFiles: string[];
}

function readCsvRows(path: string): RawRecord[] {
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8');
  if (!raw.trim()) return [];
  return parseCsvSync(raw, { columns: true, skip_empty_lines: true, bom: true }) as RawRecord[];
}

function readCsvColumns(path: string, rows: RawRecord[]): string[] {
  if (rows.length > 0) return Object.keys(rows[0] ?? {});
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, 'utf-8').trim();
  if (!raw) return [];
  const header = parseCsvSync(raw, { to_line: 1, bom: true }) as string[][];
  return header[0] ?? [];
}

function finalDispositionOf(row: RawRecord): FinalDisposition {
  const value = (row._final_disposition ?? '').trim();
  if (
    value === 'mainline_ready'
    || value === 'review'
    || value === 'archive_only'
    || value === 'quarantine'
    || value === 'inserted'
    || value === 'updated'
    || value === 'unchanged'
    || value === 'duplicate'
  ) {
    return value;
  }
  throw new Error(`handoff bundle requires _final_disposition on every row; missing on row fingerprint=${row._row_fingerprint ?? ''}`);
}

function parentBucketOf(row: RawRecord): ParentExtractionClassification {
  const value = (row._parent_extraction_classification ?? '').trim();
  if (
    value === 'not_applicable'
    || value === 'parent_candidate'
    || value === 'ambiguous_parent'
    || value === 'child_continuation'
  ) {
    return value;
  }
  return 'not_applicable';
}

function compareRows(a: RawRecord, b: RawRecord): number {
  const keys = [
    '_final_disposition',
    '_final_disposition_reason',
    '_parent_extraction_classification',
    '_source_file',
    '_source_key',
    '_source_record_key',
    '_row_fingerprint',
  ] as const;
  for (const key of keys) {
    const left = a[key] ?? '';
    const right = b[key] ?? '';
    const compared = left.localeCompare(right, 'ja');
    if (compared !== 0) return compared;
  }
  return JSON.stringify(a).localeCompare(JSON.stringify(b), 'ja');
}

function uniqueParentBuckets(rows: RawRecord[]): ParentExtractionClassification[] {
  const seen = new Set<ParentExtractionClassification>();
  for (const row of rows) {
    seen.add(parentBucketOf(row));
  }
  return ALL_PACK_PARENT_BUCKETS.filter((bucket) => seen.has(bucket));
}

function artifactView(
  file: string,
  rows: RawRecord[],
  finalDispositions: FinalDisposition[],
): HandoffArtifactView {
  const finalDispositionBreakdown = Object.fromEntries(ALL_FINAL_DISPOSITIONS.map((disposition) => [disposition, 0])) as Record<FinalDisposition, number>;
  for (const row of rows) {
    finalDispositionBreakdown[finalDispositionOf(row)]++;
  }
  return {
    file,
    rowCount: rows.length,
    finalDispositions,
    finalDispositionBreakdown,
    parentExtractionBuckets: uniqueParentBuckets(rows),
  };
}

function expectedOpsCount(reconciliation: CountReconciliationSummary): number {
  return MAINLINE_HANDOFF_DISPOSITIONS.reduce((sum, disposition) => sum + (reconciliation.finalDispositionBreakdown[disposition] ?? 0), 0);
}

function expectedReviewCount(reconciliation: CountReconciliationSummary): number {
  return REVIEW_PACK_DISPOSITIONS.reduce((sum, disposition) => sum + (reconciliation.finalDispositionBreakdown[disposition] ?? 0), 0);
}

function expectedQuarantineCount(reconciliation: CountReconciliationSummary): number {
  return QUARANTINE_PACK_DISPOSITIONS.reduce((sum, disposition) => sum + (reconciliation.finalDispositionBreakdown[disposition] ?? 0), 0);
}

function renderHandoffMarkdown(summary: HandoffBundleSummary, nextActionView: NextActionView): string {
  const artifactLabel = (artifact: HandoffArtifactView): string => {
    if (artifact.file === 'review-pack.csv') {
      const reviewCount = artifact.finalDispositionBreakdown.review ?? 0;
      const archiveOnlyCount = artifact.finalDispositionBreakdown.archive_only ?? 0;
      return `${artifact.file} (review=${reviewCount.toLocaleString()}, archive_only=${archiveOnlyCount.toLocaleString()})`;
    }
    return artifact.file;
  };
  const lines: string[] = [
    '# Handoff Summary',
    '',
    '- projection-only: true',
    `- recordCount: ${summary.integrity.recordCount.toLocaleString()}`,
    `- accountedRowCount: ${summary.integrity.accountedRowCount.toLocaleString()}`,
    `- unaccountedRowCount: ${summary.integrity.unaccountedRowCount.toLocaleString()}`,
    '',
    '## Artifacts',
    '',
    '| Artifact | Rows | Final Dispositions |',
    '|----------|------|--------------------|',
  ];

  for (const artifact of nextActionView.artifacts) {
    lines.push(`| ${artifactLabel(artifact)} | ${artifact.rowCount.toLocaleString()} | ${artifact.finalDispositions.join(', ')} |`);
  }

  lines.push('', '## Integrity', '', `- matchesReconciliation: ${summary.integrity.matchesReconciliation ? 'yes' : 'no'}`);
  return lines.join('\n');
}

export async function generateHandoffBundle(input: HandoffBundleInput): Promise<HandoffBundleResult> {
  const normalizedRows = readCsvRows(input.normalizedPath).sort(compareRows);
  const quarantineRows = readCsvRows(input.quarantinePath).sort(compareRows);
  const normalizedColumns = readCsvColumns(input.normalizedPath, normalizedRows);
  const quarantineColumns = readCsvColumns(input.quarantinePath, quarantineRows);

  const mainlineHandoffRows = normalizedRows.filter((row) => MAINLINE_HANDOFF_DISPOSITIONS.includes(finalDispositionOf(row)));
  const reviewPackRows = normalizedRows.filter((row) => REVIEW_PACK_DISPOSITIONS.includes(finalDispositionOf(row)));
  const quarantinePackRows = quarantineRows.filter((row) => QUARANTINE_PACK_DISPOSITIONS.includes(finalDispositionOf(row)));

  const expectedOps = expectedOpsCount(input.reconciliation);
  const expectedReview = expectedReviewCount(input.reconciliation);
  const expectedQuarantine = expectedQuarantineCount(input.reconciliation);
  const total = mainlineHandoffRows.length + reviewPackRows.length + quarantinePackRows.length;
  const matchesReconciliation =
    input.reconciliation.unaccountedRowCount === 0
    && input.reconciliation.accountedRowCount === input.recordCount
    && mainlineHandoffRows.length === expectedOps
    && reviewPackRows.length === expectedReview
    && quarantinePackRows.length === expectedQuarantine
    && total === input.reconciliation.accountedRowCount;

  if (!matchesReconciliation) {
    throw new Error(
      `handoff bundle count mismatch: mainline=${mainlineHandoffRows.length}/${expectedOps} review=${reviewPackRows.length}/${expectedReview} quarantine=${quarantinePackRows.length}/${expectedQuarantine} accounted=${input.reconciliation.accountedRowCount}/${input.recordCount}`,
    );
  }

  const mainlineHandoffFile = join(input.outputDir, 'mainline-handoff.csv');
  const reviewPackFile = join(input.outputDir, 'review-pack.csv');
  const quarantinePackFile = join(input.outputDir, 'quarantine-pack.csv');
  await writeCsv(mainlineHandoffFile, mainlineHandoffRows, normalizedColumns);
  await writeCsv(reviewPackFile, reviewPackRows, normalizedColumns);
  await writeCsv(quarantinePackFile, quarantinePackRows, quarantineColumns);

  const summary: HandoffBundleSummary = {
    generatedAt: new Date().toISOString(),
    projectionOnly: true,
    sourceArtifacts: {
      normalized: 'normalized.csv',
      quarantine: 'quarantine.csv',
      reconciliation: 'count-reconciliation.json',
    },
    counts: {
      opsCoreReady: mainlineHandoffRows.length,
      reviewPack: reviewPackRows.length,
      quarantinePack: quarantinePackRows.length,
      total,
    },
    integrity: {
      recordCount: input.recordCount,
      accountedRowCount: input.reconciliation.accountedRowCount,
      unaccountedRowCount: input.reconciliation.unaccountedRowCount,
      matchesReconciliation: true,
    },
    artifacts: {
      opsCoreReady: artifactView('mainline-handoff.csv', mainlineHandoffRows, MAINLINE_HANDOFF_DISPOSITIONS),
      reviewPack: artifactView('review-pack.csv', reviewPackRows, REVIEW_PACK_DISPOSITIONS),
      quarantinePack: artifactView('quarantine-pack.csv', quarantinePackRows, QUARANTINE_PACK_DISPOSITIONS),
    },
  };

  const nextActionView: NextActionView = {
    countIntegrity: 'matched',
    artifacts: [
      summary.artifacts.reviewPack,
      summary.artifacts.quarantinePack,
      summary.artifacts.opsCoreReady,
    ],
  };

  writeFileSync(join(input.outputDir, 'handoff-summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
  writeFileSync(join(input.outputDir, 'handoff-summary.md'), renderHandoffMarkdown(summary, nextActionView), 'utf-8');

  return {
    summary,
    nextActionView,
    generatedFiles: [
      'mainline-handoff.csv',
      'review-pack.csv',
      'quarantine-pack.csv',
      'handoff-summary.json',
      'handoff-summary.md',
    ],
  };
}
