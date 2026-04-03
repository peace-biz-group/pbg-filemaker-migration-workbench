import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCsv } from '../../src/io/csv-writer.js';
import { summarizeIdentity } from '../../src/core/pipeline-runner.js';

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
});
