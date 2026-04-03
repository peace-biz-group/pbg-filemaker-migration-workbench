import { writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadConfig } from '../src/config/defaults.js';
import { executeRun } from '../src/core/pipeline-runner.js';

export interface CompareRow {
  label: string;
  runId: string;
  status: string;
  totalRecordCount: number;
  mainlineReadyCount: number;
  reviewCount: number;
  archiveOnlyCount: number;
  identityWarningCount: number;
  skippedReviewCount: number;
  reviewReasonBreakdown: Record<string, number>;
  mergeEligibilityBreakdown: Record<string, number>;
  sourceRecordKeyMethodBreakdown: Record<string, number>;
  recordFamilyBreakdown: Record<string, number>;
  topReviewReasons: Array<{ reason: string; count: number }>;
  topWarningIndicators: Array<{ indicator: string; count: number }>;
  reviewSampleSummary: {
    sampleCap: number;
    reasons: Record<string, number>;
    totalSampledRows: number;
    artifactFile: string;
  };
  tuningHints: {
    likely_tuning_targets: string[];
    family_with_highest_review_ratio: { family: string; reviewRatio: number; reviewCount: number; totalCount: number } | null;
    key_method_with_highest_review_ratio: { method: string; reviewRatio: number; reviewCount: number; totalCount: number } | null;
    dominant_review_reasons: Array<{ reason: string; count: number }>;
    likely_next_checks: string[];
  };
  mainlineReadyRatio: number;
  reviewRatio: number;
  archiveOnlyRatio: number;
}

export interface CompareRecommendations {
  highest_review_ratio_run: { label: string; runId: string; reviewRatio: number } | null;
  likely_tuning_targets: Array<{ target: string; runLabels: string[] }>;
  dominant_review_reasons: Array<{ reason: string; totalCount: number }>;
  likely_next_checks: string[];
  sample_inspection: Array<{ label: string; runId: string; artifactFile: string; reasons: string[] }>;
}

export function buildCompareRecommendations(rows: CompareRow[]): CompareRecommendations {
  const highest = [...rows].sort((a, b) => b.reviewRatio - a.reviewRatio)[0];
  const targetMap: Record<string, Set<string>> = {};
  const reasonMap: Record<string, number> = {};
  const checks = new Set<string>();
  for (const row of rows) {
    for (const t of row.tuningHints.likely_tuning_targets ?? []) {
      if (!targetMap[t]) targetMap[t] = new Set();
      targetMap[t].add(row.label);
    }
    for (const r of row.tuningHints.dominant_review_reasons ?? []) {
      reasonMap[r.reason] = (reasonMap[r.reason] ?? 0) + r.count;
    }
    for (const c of row.tuningHints.likely_next_checks ?? []) {
      checks.add(`${row.label}: ${c}`);
    }
  }
  return {
    highest_review_ratio_run: highest ? { label: highest.label, runId: highest.runId, reviewRatio: Number(highest.reviewRatio.toFixed(4)) } : null,
    likely_tuning_targets: Object.entries(targetMap).map(([target, labels]) => ({ target, runLabels: Array.from(labels) })),
    dominant_review_reasons: Object.entries(reasonMap)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([reason, totalCount]) => ({ reason, totalCount })),
    likely_next_checks: Array.from(checks).slice(0, 20),
    sample_inspection: rows.map((r) => ({
      label: r.label,
      runId: r.runId,
      artifactFile: r.reviewSampleSummary.artifactFile,
      reasons: Object.keys(r.reviewSampleSummary.reasons ?? {}),
    })),
  };
}

export function renderCompareMarkdown(rows: CompareRow[]): string {
  const recommendations = buildCompareRecommendations(rows);
  const header = [
    '# Dry-run Compare (主要4系統)',
    '',
    '| label | runId | status | total | mainline_ready | review | archive_only | identityWarning | skippedReview | mainline_ratio | review_ratio |',
    '|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
  ];
  const body = rows.map((r) =>
    `| ${r.label} | ${r.runId} | ${r.status} | ${r.totalRecordCount} | ${r.mainlineReadyCount} | ${r.reviewCount} | ${r.archiveOnlyCount} | ${r.identityWarningCount} | ${r.skippedReviewCount} | ${r.mainlineReadyRatio.toFixed(3)} | ${r.reviewRatio.toFixed(3)} |`
  );

  const details = rows.map((r) => [
    '',
    `## ${r.label}`,
    '',
    '### reviewReasonBreakdown',
    '```json',
    JSON.stringify(r.reviewReasonBreakdown, null, 2),
    '```',
    '',
    '### mergeEligibilityBreakdown',
    '```json',
    JSON.stringify(r.mergeEligibilityBreakdown, null, 2),
    '```',
    '',
    '### sourceRecordKeyMethodBreakdown',
    '```json',
    JSON.stringify(r.sourceRecordKeyMethodBreakdown, null, 2),
    '```',
    '',
    '### recordFamilyBreakdown',
    '```json',
    JSON.stringify(r.recordFamilyBreakdown, null, 2),
    '```',
    '',
    '### topReviewReasons',
    '```json',
    JSON.stringify(r.topReviewReasons, null, 2),
    '```',
    '',
    '### topWarningIndicators',
    '```json',
    JSON.stringify(r.topWarningIndicators, null, 2),
    '```',
    '',
    '### tuningHints',
    '```json',
    JSON.stringify(r.tuningHints, null, 2),
    '```',
    '',
    '### reviewSampleSummary',
    '```json',
    JSON.stringify(r.reviewSampleSummary, null, 2),
    '```',
  ].join('\n'));

  const nextChecks = [
    '',
    '## Next checks',
    '',
    '### compare-level recommendations',
    '```json',
    JSON.stringify(recommendations, null, 2),
    '```',
    '',
    ...rows.flatMap((r) => [
      `- ${r.label}: targets=${(r.tuningHints.likely_tuning_targets ?? []).join(', ') || 'none'}`,
      `  - dominant_reasons=${(r.tuningHints.dominant_review_reasons ?? []).map((x) => `${x.reason}(${x.count})`).join(', ') || 'none'}`,
      `  - next_checks=${(r.tuningHints.likely_next_checks ?? []).join(' | ') || 'none'}`,
    ]),
    '',
    '## Sample inspection',
    '',
    ...rows.flatMap((r) => [
      `- ${r.label}: ${r.reviewSampleSummary.artifactFile}`,
      `  - reasons_with_samples=${Object.keys(r.reviewSampleSummary.reasons ?? {}).join(', ') || 'none'}`,
      `  - sampled_rows=${r.reviewSampleSummary.totalSampledRows} (cap=${r.reviewSampleSummary.sampleCap})`,
    ]),
  ];

  return [...header, ...body, ...details, ...nextChecks].join('\n');
}

async function main(): Promise<void> {
  const configPath = process.env.CONFIG || process.argv[2] || 'workbench.config.json';
  const outputDir = resolve(process.env.OUTPUT_DIR || process.argv[3] || './output');

  const targets = [
    { label: 'apo-list', file: process.env.APO_FILE, sourceKey: 'apo-list' },
    { label: 'customer-management', file: process.env.CUSTOMER_FILE, sourceKey: 'customer-management' },
    { label: 'call-history', file: process.env.CALL_FILE, sourceKey: 'call-history' },
    { label: 'retry-followup', file: process.env.RETRY_FILE, sourceKey: 'retry-followup' },
  ].filter((t) => t.file && t.file.trim().length > 0) as Array<{ label: string; file: string; sourceKey: string }>;

  if (targets.length === 0) {
    console.error('No input files. Set APO_FILE/CUSTOMER_FILE/CALL_FILE/RETRY_FILE.');
    process.exit(1);
  }

  const rows: CompareRow[] = [];
  for (const t of targets) {
    const config = loadConfig(configPath);
    config.outputDir = outputDir;
    config.inputs = [{ path: t.file, label: t.label, sourceKey: t.sourceKey, mode: 'mainline' }];

    console.log(`[dry-run] ${t.label}: ${t.file}`);
    const meta = await executeRun('run-all', [t.file], config, configPath);
    const s = meta.summary ?? {};
    rows.push({
      label: t.label,
      runId: meta.id,
      status: meta.status,
      totalRecordCount: s.totalRecordCount ?? s.recordCount ?? 0,
      mainlineReadyCount: s.mainlineReadyCount ?? 0,
      reviewCount: s.reviewCount ?? 0,
      archiveOnlyCount: s.archiveOnlyCount ?? 0,
      identityWarningCount: s.identityWarningCount ?? 0,
      skippedReviewCount: s.skippedReviewCount ?? 0,
      reviewReasonBreakdown: s.reviewReasonBreakdown ?? {},
      mergeEligibilityBreakdown: s.mergeEligibilityBreakdown ?? {},
      sourceRecordKeyMethodBreakdown: s.sourceRecordKeyMethodBreakdown ?? {},
      recordFamilyBreakdown: s.recordFamilyBreakdown ?? {},
      topReviewReasons: s.topReviewReasons ?? [],
      topWarningIndicators: s.topWarningIndicators ?? [],
      reviewSampleSummary: s.reviewSampleSummary ?? {
        sampleCap: 5,
        reasons: {},
        totalSampledRows: 0,
        artifactFile: 'identity-review-samples.json',
      },
      tuningHints: s.tuningHints ?? {
        likely_tuning_targets: [],
        family_with_highest_review_ratio: null,
        key_method_with_highest_review_ratio: null,
        dominant_review_reasons: [],
        likely_next_checks: [],
      },
      mainlineReadyRatio: (s.totalRecordCount ?? s.recordCount ?? 0) > 0 ? (s.mainlineReadyCount ?? 0) / (s.totalRecordCount ?? s.recordCount ?? 0) : 0,
      reviewRatio: (s.totalRecordCount ?? s.recordCount ?? 0) > 0 ? (s.reviewCount ?? 0) / (s.totalRecordCount ?? s.recordCount ?? 0) : 0,
      archiveOnlyRatio: (s.totalRecordCount ?? s.recordCount ?? 0) > 0 ? (s.archiveOnlyCount ?? 0) / (s.totalRecordCount ?? s.recordCount ?? 0) : 0,
    });
  }

  mkdirSync(outputDir, { recursive: true });
  const compareJsonPath = join(outputDir, 'dry-run-compare.json');
  const compareMdPath = join(outputDir, 'dry-run-compare.md');
  writeFileSync(compareJsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), rows, recommendations: buildCompareRecommendations(rows) }, null, 2), 'utf-8');
  writeFileSync(compareMdPath, renderCompareMarkdown(rows), 'utf-8');
  console.log(`[dry-run] wrote ${compareJsonPath}`);
  console.log(`[dry-run] wrote ${compareMdPath}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname)) {
  main();
}
