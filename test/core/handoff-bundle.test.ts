import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeCsv } from '../../src/io/csv-writer.js';
import { generateHandoffBundle } from '../../src/core/handoff-bundle.js';
import type { CountReconciliationSummary } from '../../src/types/index.js';

function reconciliation(): CountReconciliationSummary {
  return {
    inputRowCount: 5,
    normalizedRowCount: 4,
    quarantineRowCount: 1,
    accountedRowCount: 5,
    unaccountedRowCount: 0,
    parentExtractionBreakdown: {
      not_applicable: 0,
      parent_candidate: 2,
      ambiguous_parent: 2,
      child_continuation: 1,
    },
    eligibilityBreakdown: {
      mainline_ready: 2,
      review: 2,
      archive_only: 0,
      quarantine: 1,
    },
    finalDispositionBreakdown: {
      mainline_ready: 0,
      review: 2,
      archive_only: 0,
      quarantine: 1,
      inserted: 1,
      updated: 0,
      unchanged: 0,
      duplicate: 1,
    },
    extractionToEligibility: {
      not_applicable: { mainline_ready: 0, review: 0, archive_only: 0, quarantine: 0 },
      parent_candidate: { mainline_ready: 2, review: 0, archive_only: 0, quarantine: 0 },
      ambiguous_parent: { mainline_ready: 0, review: 2, archive_only: 0, quarantine: 0 },
      child_continuation: { mainline_ready: 0, review: 0, archive_only: 0, quarantine: 1 },
    },
    extractionToDisposition: {
      not_applicable: { mainline_ready: 0, review: 0, archive_only: 0, quarantine: 0, inserted: 0, updated: 0, unchanged: 0, duplicate: 0 },
      parent_candidate: { mainline_ready: 0, review: 0, archive_only: 0, quarantine: 0, inserted: 1, updated: 0, unchanged: 0, duplicate: 1 },
      ambiguous_parent: { mainline_ready: 0, review: 2, archive_only: 0, quarantine: 0, inserted: 0, updated: 0, unchanged: 0, duplicate: 0 },
      child_continuation: { mainline_ready: 0, review: 0, archive_only: 0, quarantine: 1, inserted: 0, updated: 0, unchanged: 0, duplicate: 0 },
    },
    eligibilityToDisposition: {
      mainline_ready: { mainline_ready: 0, review: 0, archive_only: 0, quarantine: 0, inserted: 1, updated: 0, unchanged: 0, duplicate: 1 },
      review: { mainline_ready: 0, review: 2, archive_only: 0, quarantine: 0, inserted: 0, updated: 0, unchanged: 0, duplicate: 0 },
      archive_only: { mainline_ready: 0, review: 0, archive_only: 0, quarantine: 0, inserted: 0, updated: 0, unchanged: 0, duplicate: 0 },
      quarantine: { mainline_ready: 0, review: 0, archive_only: 0, quarantine: 1, inserted: 0, updated: 0, unchanged: 0, duplicate: 0 },
    },
    dispositionReasonBreakdown: {
      new_identity: 1,
      same_batch_same_fingerprint: 1,
      mixed_parent_child_ambiguous: 1,
      deterministic_collision: 1,
      CHILD_CONTINUATION: 1,
    },
    dispositionReasonByFinalDisposition: {
      mainline_ready: {},
      review: { mixed_parent_child_ambiguous: 1, deterministic_collision: 1 },
      archive_only: {},
      quarantine: { CHILD_CONTINUATION: 1 },
      inserted: { new_identity: 1 },
      updated: {},
      unchanged: {},
      duplicate: { same_batch_same_fingerprint: 1 },
    },
  };
}

describe('handoff bundle', () => {
  it('projects existing final row state only and keeps counts aligned with reconciliation', async () => {
    const out = mkdtempSync(join(tmpdir(), 'handoff-bundle-'));
    const normalized = join(out, 'normalized.csv');
    const quarantine = join(out, 'quarantine.csv');

    await writeCsv(normalized, [
      { _merge_eligibility: 'mainline_ready', _final_disposition: 'inserted', _final_disposition_reason: 'new_identity', _parent_extraction_classification: 'parent_candidate', _source_file: 'a.xlsx', _source_key: 'a', _source_record_key: '1', _row_fingerprint: 'fp1' },
      { _merge_eligibility: 'mainline_ready', _final_disposition: 'duplicate', _final_disposition_reason: 'same_batch_same_fingerprint', _parent_extraction_classification: 'parent_candidate', _source_file: 'a.xlsx', _source_key: 'a', _source_record_key: '2', _row_fingerprint: 'fp2' },
      { _merge_eligibility: 'mainline_ready', _final_disposition: 'review', _final_disposition_reason: 'deterministic_collision', _parent_extraction_classification: 'ambiguous_parent', _source_file: 'a.xlsx', _source_key: 'a', _source_record_key: '3', _row_fingerprint: 'fp3' },
      { _merge_eligibility: 'review', _final_disposition: 'review', _final_disposition_reason: 'mixed_parent_child_ambiguous', _parent_extraction_classification: 'ambiguous_parent', _source_file: 'a.xlsx', _source_key: 'a', _source_record_key: '4', _row_fingerprint: 'fp4' },
    ]);
    await writeCsv(quarantine, [
      { _merge_eligibility: 'quarantine', _final_disposition: 'quarantine', _final_disposition_reason: 'CHILD_CONTINUATION', _quarantine_reason: 'CHILD_CONTINUATION', _parent_extraction_classification: 'child_continuation', _source_file: 'a.xlsx', _source_key: 'a', _source_record_key: '5', _row_fingerprint: 'fp5' },
    ]);

    const result = await generateHandoffBundle({
      outputDir: out,
      normalizedPath: normalized,
      quarantinePath: quarantine,
      reconciliation: reconciliation(),
      recordCount: 5,
    });

    expect(result.summary.projectionOnly).toBe(true);
    expect(result.summary.counts.opsCoreReady).toBe(2);
    expect(result.summary.counts.reviewPack).toBe(2);
    expect(result.summary.counts.quarantinePack).toBe(1);
    expect(result.summary.integrity.matchesReconciliation).toBe(true);
    expect(result.nextActionView.countIntegrity).toBe('matched');
    expect(result.summary.artifacts.reviewPack.finalDispositionBreakdown.review).toBe(2);
    expect(result.summary.artifacts.reviewPack.finalDispositionBreakdown.archive_only).toBe(0);

    const opsReady = readFileSync(join(out, 'mainline-handoff.csv'), 'utf-8');
    const reviewPack = readFileSync(join(out, 'review-pack.csv'), 'utf-8');
    const quarantinePack = readFileSync(join(out, 'quarantine-pack.csv'), 'utf-8');
    expect(opsReady).toContain('inserted');
    expect(opsReady).toContain('duplicate');
    expect(reviewPack).toContain('deterministic_collision');
    expect(reviewPack).toContain('mixed_parent_child_ambiguous');
    expect(quarantinePack).toContain('CHILD_CONTINUATION');
    expect(reviewPack).not.toContain('duplicate');
  });

  it('keeps output order stable for the same row state', async () => {
    const out = mkdtempSync(join(tmpdir(), 'handoff-bundle-stable-'));
    const normalized = join(out, 'normalized.csv');
    const quarantine = join(out, 'quarantine.csv');
    await writeCsv(normalized, [
      { _merge_eligibility: 'review', _final_disposition: 'review', _final_disposition_reason: 'z_reason', _parent_extraction_classification: 'ambiguous_parent', _source_file: 'b.xlsx', _source_key: 'b', _source_record_key: '2', _row_fingerprint: 'fp2' },
      { _merge_eligibility: 'mainline_ready', _final_disposition: 'inserted', _final_disposition_reason: 'a_reason', _parent_extraction_classification: 'parent_candidate', _source_file: 'a.xlsx', _source_key: 'a', _source_record_key: '1', _row_fingerprint: 'fp1' },
    ]);
    await writeCsv(quarantine, [
      { _merge_eligibility: 'quarantine', _final_disposition: 'quarantine', _final_disposition_reason: 'CHILD_CONTINUATION', _quarantine_reason: 'CHILD_CONTINUATION', _parent_extraction_classification: 'child_continuation', _source_file: 'c.xlsx', _source_key: 'c', _source_record_key: '3', _row_fingerprint: 'fp3' },
    ]);
    const stableReconciliation = {
      ...reconciliation(),
      inputRowCount: 3,
      normalizedRowCount: 2,
      quarantineRowCount: 1,
      accountedRowCount: 3,
      parentExtractionBreakdown: { not_applicable: 0, parent_candidate: 1, ambiguous_parent: 1, child_continuation: 1 },
      eligibilityBreakdown: { mainline_ready: 1, review: 1, archive_only: 0, quarantine: 1 },
      finalDispositionBreakdown: { mainline_ready: 0, review: 1, archive_only: 0, quarantine: 1, inserted: 1, updated: 0, unchanged: 0, duplicate: 0 },
    } satisfies CountReconciliationSummary;

    await generateHandoffBundle({ outputDir: out, normalizedPath: normalized, quarantinePath: quarantine, reconciliation: stableReconciliation, recordCount: 3 });
    const firstOps = readFileSync(join(out, 'mainline-handoff.csv'), 'utf-8');
    const firstReview = readFileSync(join(out, 'review-pack.csv'), 'utf-8');

    await generateHandoffBundle({ outputDir: out, normalizedPath: normalized, quarantinePath: quarantine, reconciliation: stableReconciliation, recordCount: 3 });
    const secondOps = readFileSync(join(out, 'mainline-handoff.csv'), 'utf-8');
    const secondReview = readFileSync(join(out, 'review-pack.csv'), 'utf-8');

    expect(firstOps).toBe(secondOps);
    expect(firstReview).toBe(secondReview);
  });

  it('fails when bundle counts do not match reconciliation', async () => {
    const out = mkdtempSync(join(tmpdir(), 'handoff-bundle-fail-'));
    const normalized = join(out, 'normalized.csv');
    const quarantine = join(out, 'quarantine.csv');
    await writeCsv(normalized, [
      { _merge_eligibility: 'mainline_ready', _final_disposition: 'inserted', _final_disposition_reason: 'new_identity', _parent_extraction_classification: 'parent_candidate', _source_file: 'a.xlsx', _source_key: 'a', _source_record_key: '1', _row_fingerprint: 'fp1' },
    ]);
    await writeCsv(quarantine, []);

    await expect(generateHandoffBundle({
      outputDir: out,
      normalizedPath: normalized,
      quarantinePath: quarantine,
      reconciliation: {
        ...reconciliation(),
        inputRowCount: 1,
        normalizedRowCount: 1,
        quarantineRowCount: 0,
        accountedRowCount: 1,
        parentExtractionBreakdown: { not_applicable: 0, parent_candidate: 1, ambiguous_parent: 0, child_continuation: 0 },
        eligibilityBreakdown: { mainline_ready: 1, review: 0, archive_only: 0, quarantine: 0 },
        finalDispositionBreakdown: { mainline_ready: 0, review: 1, archive_only: 0, quarantine: 0, inserted: 0, updated: 0, unchanged: 0, duplicate: 0 },
      },
      recordCount: 1,
    })).rejects.toThrow(/handoff bundle count mismatch/);
  });

  it('handoff summary markdown shows review/archive_only split without changing grouping', async () => {
    const out = mkdtempSync(join(tmpdir(), 'handoff-bundle-archive-'));
    const normalized = join(out, 'normalized.csv');
    const quarantine = join(out, 'quarantine.csv');
    await writeCsv(normalized, [
      { _merge_eligibility: 'review', _final_disposition: 'review', _final_disposition_reason: 'needs_check', _parent_extraction_classification: 'ambiguous_parent', _source_file: 'a.xlsx', _source_key: 'a', _source_record_key: '1', _row_fingerprint: 'fp1' },
      { _merge_eligibility: 'archive_only', _final_disposition: 'archive_only', _final_disposition_reason: 'archive_mode', _parent_extraction_classification: 'parent_candidate', _source_file: 'a.xlsx', _source_key: 'a', _source_record_key: '2', _row_fingerprint: 'fp2' },
    ]);
    await writeCsv(quarantine, []);

    await generateHandoffBundle({
      outputDir: out,
      normalizedPath: normalized,
      quarantinePath: quarantine,
      reconciliation: {
        ...reconciliation(),
        inputRowCount: 2,
        normalizedRowCount: 2,
        quarantineRowCount: 0,
        accountedRowCount: 2,
        parentExtractionBreakdown: { not_applicable: 0, parent_candidate: 1, ambiguous_parent: 1, child_continuation: 0 },
        eligibilityBreakdown: { mainline_ready: 0, review: 1, archive_only: 1, quarantine: 0 },
        finalDispositionBreakdown: { mainline_ready: 0, review: 1, archive_only: 1, quarantine: 0, inserted: 0, updated: 0, unchanged: 0, duplicate: 0 },
      },
      recordCount: 2,
    });

    const markdown = readFileSync(join(out, 'handoff-summary.md'), 'utf-8');
    expect(markdown).toContain('review-pack.csv (review=1, archive_only=1)');
  });
});
