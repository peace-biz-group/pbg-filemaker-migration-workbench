import { describe, it, expect } from 'vitest';
import { buildCompareRecommendations, renderCompareMarkdown } from '../../scripts/dry-run-4.js';

describe('dry-run-4 helper', () => {
  it('renders compare markdown table and breakdown blocks', () => {
    const md = renderCompareMarkdown([
      {
        label: 'apo-list',
        runId: 'r1',
        status: 'completed',
        totalRecordCount: 10,
        mainlineReadyCount: 6,
        reviewCount: 3,
        archiveOnlyCount: 1,
        identityWarningCount: 2,
        skippedReviewCount: 3,
        reviewReasonBreakdown: { fallback_key: 2 },
        mergeEligibilityBreakdown: { mainline_ready: 6, review: 3, archive_only: 1 },
        sourceRecordKeyMethodBreakdown: { deterministic: 8, fallback: 2 },
        recordFamilyBreakdown: { apo_list: 10 },
        topReviewReasons: [{ reason: 'fallback_key', count: 2 }],
        topWarningIndicators: [{ indicator: 'fallback_key', count: 2 }],
        reviewSampleSummary: {
          sampleCap: 5,
          reasons: { fallback_key: 2 },
          totalSampledRows: 2,
          artifactFile: 'identity-review-samples.json',
        },
        tuningHints: {
          likely_tuning_targets: ['source_record_key'],
          family_with_highest_review_ratio: { family: 'apo_list', reviewRatio: 0.3, reviewCount: 3, totalCount: 10 },
          key_method_with_highest_review_ratio: { method: 'fallback', reviewRatio: 1, reviewCount: 2, totalCount: 2 },
          dominant_review_reasons: [{ reason: 'fallback_key', count: 2 }],
          likely_next_checks: ['inspect source native IDs and deterministic field set for dominant family'],
        },
        mainlineReadyRatio: 0.6,
        reviewRatio: 0.3,
        archiveOnlyRatio: 0.1,
      },
    ]);

    expect(md).toContain('| apo-list | r1 | completed | 10 | 6 | 3 | 1 | 2 | 3 | 0.600 | 0.300 |');
    expect(md).toContain('fallback_key');
    expect(md).toContain('mergeEligibilityBreakdown');
    expect(md).toContain('sourceRecordKeyMethodBreakdown');
    expect(md).toContain('## Next checks');
    expect(md).toContain('compare-level recommendations');
    expect(md).toContain('## Sample inspection');
    expect(md).toContain('identity-review-samples.json');
  });

  it('builds compare-level recommendations', () => {
    const recommendations = buildCompareRecommendations([
      {
        label: 'apo-list',
        runId: 'r1',
        status: 'completed',
        totalRecordCount: 10,
        mainlineReadyCount: 6,
        reviewCount: 3,
        archiveOnlyCount: 1,
        identityWarningCount: 2,
        skippedReviewCount: 3,
        reviewReasonBreakdown: { fallback_key: 2 },
        mergeEligibilityBreakdown: { mainline_ready: 6, review: 3, archive_only: 1 },
        sourceRecordKeyMethodBreakdown: { deterministic: 8, fallback: 2 },
        recordFamilyBreakdown: { apo_list: 10 },
        topReviewReasons: [{ reason: 'fallback_key', count: 2 }],
        topWarningIndicators: [{ indicator: 'fallback_key', count: 2 }],
        reviewSampleSummary: {
          sampleCap: 5,
          reasons: { fallback_key: 2 },
          totalSampledRows: 2,
          artifactFile: 'identity-review-samples.json',
        },
        tuningHints: {
          likely_tuning_targets: ['source_record_key'],
          family_with_highest_review_ratio: { family: 'apo_list', reviewRatio: 0.3, reviewCount: 3, totalCount: 10 },
          key_method_with_highest_review_ratio: { method: 'fallback', reviewRatio: 1, reviewCount: 2, totalCount: 2 },
          dominant_review_reasons: [{ reason: 'fallback_key', count: 2 }],
          likely_next_checks: ['inspect source native IDs and deterministic field set for dominant family'],
        },
        mainlineReadyRatio: 0.6,
        reviewRatio: 0.3,
        archiveOnlyRatio: 0.1,
      },
    ]);
    expect(recommendations.highest_review_ratio_run?.label).toBe('apo-list');
    expect(recommendations.likely_tuning_targets[0]?.target).toBe('source_record_key');
    expect(recommendations.sample_inspection[0]?.artifactFile).toBe('identity-review-samples.json');
  });
});
