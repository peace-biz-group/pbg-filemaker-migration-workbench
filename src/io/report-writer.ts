/**
 * Report writer — generates summary.json and summary.md.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ReportSummary, ProfileResult } from '../types/index.js';

/** Remove control characters (except tab/newline) from a string for safe Markdown output. */
function sanitizeForMarkdown(s: string): string {
  return s.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

export function ensureOutputDir(outputDir: string): void {
  mkdirSync(outputDir, { recursive: true });
}

export function writeSummaryJson(outputDir: string, summary: ReportSummary): void {
  writeFileSync(join(outputDir, 'summary.json'), JSON.stringify(summary, null, 2), 'utf-8');
}

export function writeSummaryMarkdown(outputDir: string, summary: ReportSummary, profile?: ProfileResult): void {
  const nextActionLabel = (artifact: NonNullable<ReportSummary['nextActionView']>['artifacts'][number]): string => {
    if (artifact.file === 'review-pack.csv') {
      const reviewCount = artifact.finalDispositionBreakdown.review ?? 0;
      const archiveOnlyCount = artifact.finalDispositionBreakdown.archive_only ?? 0;
      return `${artifact.file} (review=${reviewCount.toLocaleString()}, archive_only=${archiveOnlyCount.toLocaleString()})`;
    }
    return artifact.file;
  };
  const lines: string[] = [
    '# FileMaker Data Workbench — Summary Report',
    '',
    `**Generated:** ${summary.generatedAt}`,
    `**Input:** ${sanitizeForMarkdown(summary.inputFile)}`,
    '',
    '## Overview',
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Input File | ${sanitizeForMarkdown(summary.inputFile)} |`,
    `| Records | ${summary.recordCount.toLocaleString()} |`,
    `| Columns | ${summary.columnCount} |`,
    `| Normalized | ${summary.normalizedCount.toLocaleString()} |`,
    `| Quarantine | ${summary.quarantineCount.toLocaleString()} |`,
    `| Duplicate Groups | ${summary.duplicateGroupCount.toLocaleString()} |`,
    '',
  ];

  // Classification breakdown
  lines.push('## Classification Breakdown', '');
  lines.push('| Type | Count |', '|------|-------|');
  for (const [type, count] of Object.entries(summary.classificationBreakdown)) {
    lines.push(`| ${type} | ${count.toLocaleString()} |`);
  }
  lines.push('');

  if (summary.sourceRoutingDecisions && Object.keys(summary.sourceRoutingDecisions).length > 0) {
    lines.push('## Source Routing', '');
    lines.push('| Source | Mode | Reason | Mixed Export |');
    lines.push('|--------|------|--------|--------------|');
    for (const [file, decision] of Object.entries(summary.sourceRoutingDecisions)) {
      lines.push(
        `| ${sanitizeForMarkdown(basename(file))} | ${decision.mode} | ${sanitizeForMarkdown(decision.reason)} | ${decision.mixedParentChildExport ? 'yes' : 'no'} |`,
      );
    }
    lines.push('');
  }

  if (summary.sourceRecordFlows && Object.keys(summary.sourceRecordFlows).length > 0) {
    lines.push('## Source Record Flow', '');
    lines.push('| Source | Input Rows | Parent Candidates | Ambiguous Parent | Quarantine | Child-only | Mixed Parent+Child |');
    lines.push('|--------|------------|-------------------|------------------|------------|------------|--------------------|');
    for (const [file, flow] of Object.entries(summary.sourceRecordFlows)) {
      lines.push(
        `| ${sanitizeForMarkdown(basename(file))} | ${flow.inputRowCount.toLocaleString()} | ${flow.parentCandidateRowCount.toLocaleString()} | ${flow.ambiguousParentRowCount.toLocaleString()} | ${flow.quarantineRowCount.toLocaleString()} | ${flow.childOnlyContinuationRowCount.toLocaleString()} | ${flow.mixedParentChildRowCount.toLocaleString()} |`,
      );
    }
    lines.push('');
  }

  if (summary.parentExtractionSummaries && Object.keys(summary.parentExtractionSummaries).length > 0) {
    lines.push('## Parent Extraction', '');
    lines.push('| Source | Extracted Parent | Ambiguous | Child Continuation |');
    lines.push('|--------|------------------|-----------|--------------------|');
    for (const [file, extraction] of Object.entries(summary.parentExtractionSummaries)) {
      lines.push(
        `| ${sanitizeForMarkdown(basename(file))} | ${extraction.extractedParentCount.toLocaleString()} | ${extraction.ambiguousParentCount.toLocaleString()} | ${extraction.childContinuationCount.toLocaleString()} |`,
      );
    }
    lines.push('');
  }

  if (summary.countReconciliation) {
    lines.push('## Count Reconciliation', '');
    lines.push('| Metric | Value |');
    lines.push('|--------|-------|');
    lines.push(`| Input Rows | ${summary.countReconciliation.inputRowCount.toLocaleString()} |`);
    lines.push(`| Normalized Rows | ${summary.countReconciliation.normalizedRowCount.toLocaleString()} |`);
    lines.push(`| Quarantine Rows | ${summary.countReconciliation.quarantineRowCount.toLocaleString()} |`);
    lines.push(`| Accounted Rows | ${summary.countReconciliation.accountedRowCount.toLocaleString()} |`);
    lines.push(`| Unaccounted Rows | ${summary.countReconciliation.unaccountedRowCount.toLocaleString()} |`);
    lines.push('');
    lines.push('| Final Disposition | Count |');
    lines.push('|-------------------|-------|');
    for (const [disposition, count] of Object.entries(summary.countReconciliation.finalDispositionBreakdown)) {
      if (!count) continue;
      lines.push(`| ${sanitizeForMarkdown(disposition)} | ${count.toLocaleString()} |`);
    }
    lines.push('');
  }

  if (summary.nextActionView && summary.nextActionView.artifacts.length > 0) {
    lines.push('## Next Action Artifacts', '');
    lines.push('| Artifact | Rows | Final Dispositions |');
    lines.push('|----------|------|--------------------|');
    for (const artifact of summary.nextActionView.artifacts) {
      lines.push(
        `| ${sanitizeForMarkdown(nextActionLabel(artifact))} | ${artifact.rowCount.toLocaleString()} | ${sanitizeForMarkdown(artifact.finalDispositions.join(', '))} |`,
      );
    }
    lines.push('');
  }

  // Column profiles
  if (profile) {
    lines.push('## Column Profiles', '');
    lines.push('| Column | Non-Empty | Missing Rate | Unique | Top Value |');
    lines.push('|--------|-----------|-------------|--------|-----------|');
    for (const col of profile.columns) {
      const topVal = sanitizeForMarkdown(col.topValues[0]?.value ?? '—');
      const display = topVal.length > 30 ? topVal.slice(0, 27) + '...' : topVal;
      lines.push(
        `| ${sanitizeForMarkdown(col.name)} | ${col.nonEmptyCount.toLocaleString()} | ${(col.missingRate * 100).toFixed(1)}% | ${col.uniqueCount.toLocaleString()} | ${display} |`,
      );
    }
    lines.push('');

    if (profile.anomalies.length > 0) {
      lines.push('## Anomalies (sample)', '');
      lines.push('| Row | Column | Value | Reason |');
      lines.push('|-----|--------|-------|--------|');
      const sample = profile.anomalies.slice(0, 50);
      for (const a of sample) {
        const rawVal = sanitizeForMarkdown(a.value);
        const val = rawVal.length > 30 ? rawVal.slice(0, 27) + '...' : rawVal;
        lines.push(`| ${a.row} | ${sanitizeForMarkdown(a.column)} | ${val} | ${sanitizeForMarkdown(a.reason)} |`);
      }
      if (profile.anomalies.length > 50) {
        lines.push(``, `*... and ${profile.anomalies.length - 50} more anomalies (see anomalies.csv)*`);
      }
      lines.push('');
    }
  }

  writeFileSync(join(outputDir, 'summary.md'), lines.join('\n'), 'utf-8');
}
