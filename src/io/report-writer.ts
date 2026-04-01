/**
 * Report writer — generates summary.json and summary.md.
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
