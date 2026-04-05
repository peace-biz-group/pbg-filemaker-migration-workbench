import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCsv } from '../../src/io/csv-writer.js';
import { buildCountReconciliation, summarizeIdentity } from '../../src/core/pipeline-runner.js';
import { writeSummaryMarkdown } from '../../src/io/report-writer.js';
import type { ReportSummary } from '../../src/types/index.js';

describe('pipeline runner identity summary', () => {
  it('review reason / eligibility breakdown を集計できる', async () => {
    const out = mkdtempSync(join(tmpdir(), 'identity-summary-'));
    const normalized = join(out, 'normalized.csv');
    await writeCsv(normalized, [
      { _merge_eligibility: 'mainline_ready', _review_reason: '', _source_record_key_method: 'native', _semantic_owner: 'customer_like', _source_file: 'apo.csv', id: '1' },
      { _merge_eligibility: 'review', _review_reason: 'fallback_key', _source_record_key_method: 'fallback', _semantic_owner: 'unknown', _source_file: 'apo.csv', id: '2' },
      { _merge_eligibility: 'review', _review_reason: 'deterministic_collision', _source_record_key_method: 'deterministic', _semantic_owner: 'customer_like', _source_file: 'apo.csv', id: '3' },
      { _merge_eligibility: 'archive_only', _review_reason: 'archive_mode', _source_record_key_method: 'native', _semantic_owner: 'customer_like', _source_file: 'apo.csv', id: '4' },
    ]);

    const summary = summarizeIdentity(normalized, out);
    expect(summary.totalRecords).toBe(4);
    expect(summary.mainlineReadyCount).toBe(1);
    expect(summary.reviewCount).toBe(2);
    expect(summary.archiveOnlyCount).toBe(1);
    expect(summary.reviewReasonBreakdown.fallback_key).toBe(1);
    expect(summary.reviewReasonBreakdown.deterministic_collision).toBe(1);
    expect(summary.mergeEligibilityBreakdown.review).toBe(2);
    expect(summary.sourceRecordKeyMethodBreakdown.fallback).toBe(1);
    expect(summary.reviewSourceRecordKeyMethodBreakdown.deterministic).toBe(1);
    expect(summary.topReviewReasons[0]?.reason).toBeTruthy();
    expect(summary.topWarningIndicators.length).toBeGreaterThan(0);

    const reasonJson = JSON.parse(readFileSync(join(out, 'review-reason-summary.json'), 'utf-8')) as Record<string, number>;
    const eligibilityJson = JSON.parse(readFileSync(join(out, 'merge-eligibility-summary.json'), 'utf-8')) as Record<string, number>;
    const diagnosis = JSON.parse(readFileSync(join(out, 'identity-diagnosis.json'), 'utf-8')) as { reviewCount: number; recordFamilyBreakdown: Record<string, number> };
    const tuningHints = JSON.parse(readFileSync(join(out, 'identity-tuning-hints.json'), 'utf-8')) as {
      likely_tuning_targets: string[];
      dominant_review_reasons: Array<{ reason: string; count: number }>;
      likely_next_checks: string[];
    };
    const reviewSamples = JSON.parse(readFileSync(join(out, 'identity-review-samples.json'), 'utf-8')) as {
      sampleCap: number;
      reasons: Record<string, number>;
      samples: Record<string, Array<Record<string, unknown>>>;
    };
    expect(reasonJson.archive_mode).toBe(1);
    expect(eligibilityJson.archive_only).toBe(1);
    expect(diagnosis.reviewCount).toBe(2);
    expect(Object.keys(diagnosis.recordFamilyBreakdown).length).toBeGreaterThan(0);
    expect(tuningHints.likely_tuning_targets).toContain('source_record_key');
    expect(tuningHints.dominant_review_reasons.some((r) => r.reason === 'fallback_key')).toBe(true);
    expect(tuningHints.likely_next_checks.length).toBeGreaterThan(0);
    expect(reviewSamples.sampleCap).toBe(5);
    expect(reviewSamples.reasons.fallback_key).toBe(1);
    expect(reviewSamples.samples.fallback_key[0]?.source_record_key_method).toBe('fallback');
  });

  it('mixed_parent_child_export を tuning hint に反映できる', async () => {
    const out = mkdtempSync(join(tmpdir(), 'identity-summary-mixed-'));
    const normalized = join(out, 'normalized.csv');
    await writeCsv(normalized, [
      { _merge_eligibility: 'review', _review_reason: 'mixed_parent_child_export', _source_record_key_method: 'fallback', _semantic_owner: 'unknown', _source_file: 'customer.xlsx', id: '1' },
      { _merge_eligibility: 'review', _review_reason: 'mixed_parent_child_export', _source_record_key_method: 'fallback', _semantic_owner: 'unknown', _source_file: 'customer.xlsx', id: '2' },
    ]);

    const summary = summarizeIdentity(normalized, out);
    expect(summary.reviewReasonBreakdown.mixed_parent_child_export).toBe(2);
    expect(summary.tuningHints.likely_tuning_targets).toContain('mixed_parent_child_export_handling');
    expect(summary.tuningHints.likely_next_checks.some((item) => item.includes('child history'))).toBe(true);
  });

  it('count reconciliation が normalized/quarantine/final disposition を一致させる', async () => {
    const out = mkdtempSync(join(tmpdir(), 'identity-summary-reconcile-'));
    const normalized = join(out, 'normalized.csv');
    const quarantine = join(out, 'quarantine.csv');
    await writeCsv(normalized, [
      { _parent_extraction_classification: 'parent_candidate', _merge_eligibility: 'mainline_ready', _final_disposition: 'inserted', _final_disposition_reason: 'new_identity', id: '1' },
      { _parent_extraction_classification: 'ambiguous_parent', _merge_eligibility: 'review', _final_disposition: 'review', _final_disposition_reason: 'mixed_parent_child_ambiguous', id: '2' },
      { _parent_extraction_classification: 'parent_candidate', _merge_eligibility: 'mainline_ready', _final_disposition: 'duplicate', _final_disposition_reason: 'same_batch_same_fingerprint', id: '3' },
    ]);
    await writeCsv(quarantine, [
      { _parent_extraction_classification: 'child_continuation', _quarantine_reason: 'CHILD_CONTINUATION', _final_disposition: 'quarantine', _final_disposition_reason: 'CHILD_CONTINUATION', id: '4' },
    ]);

    const summary = buildCountReconciliation(normalized, quarantine, out);
    expect(summary.inputRowCount).toBe(4);
    expect(summary.normalizedRowCount).toBe(3);
    expect(summary.quarantineRowCount).toBe(1);
    expect(summary.accountedRowCount).toBe(4);
    expect(summary.unaccountedRowCount).toBe(0);
    expect(summary.extractionToDisposition.parent_candidate.inserted).toBe(1);
    expect(summary.extractionToDisposition.parent_candidate.duplicate).toBe(1);
    expect(summary.extractionToDisposition.ambiguous_parent.review).toBe(1);
    expect(summary.extractionToDisposition.child_continuation.quarantine).toBe(1);
    expect(summary.eligibilityToDisposition.mainline_ready.inserted).toBe(1);
    expect(summary.eligibilityToDisposition.mainline_ready.duplicate).toBe(1);
    expect(summary.dispositionReasonByFinalDisposition.quarantine.CHILD_CONTINUATION).toBe(1);

    const artifact = JSON.parse(readFileSync(join(out, 'count-reconciliation.json'), 'utf-8')) as { unaccountedRowCount: number };
    expect(artifact.unaccountedRowCount).toBe(0);
  });

  it('summary markdown shows review/archive_only split for review-pack artifact', () => {
    const out = mkdtempSync(join(tmpdir(), 'identity-summary-md-'));
    const summary: ReportSummary = {
      generatedAt: new Date().toISOString(),
      inputFile: 'sample.xlsx',
      recordCount: 2,
      columnCount: 3,
      normalizedCount: 2,
      quarantineCount: 0,
      duplicateGroupCount: 0,
      classificationBreakdown: {
        customer: 2,
        deal: 0,
        transaction: 0,
        activity: 0,
        quarantine: 0,
      },
      nextActionView: {
        countIntegrity: 'matched',
        artifacts: [
          {
            file: 'review-pack.csv',
            rowCount: 2,
            finalDispositions: ['review', 'archive_only'],
            finalDispositionBreakdown: {
              mainline_ready: 0,
              review: 1,
              archive_only: 1,
              quarantine: 0,
              inserted: 0,
              updated: 0,
              unchanged: 0,
              duplicate: 0,
            },
            parentExtractionBuckets: ['ambiguous_parent', 'parent_candidate'],
          },
        ],
      },
    };

    writeSummaryMarkdown(out, summary);
    const markdown = readFileSync(join(out, 'summary.md'), 'utf-8');
    expect(markdown).toContain('review-pack.csv (review=1, archive_only=1)');
  });
});
