import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/defaults.js';
import { executeRun } from '../../src/core/pipeline-runner.js';
import {
  createReview,
  getReview,
  listReviews,
  updateReviewColumns,
  updateReviewSummary,
  deleteReview,
  generateBundle,
  computeFileHash,
  computeSchemaFingerprint,
} from '../../src/core/review-bundle.js';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const APO_LIST = join(FIXTURES, 'apo_list_2024.csv');
const CONFIG_PATH = join(FIXTURES, 'test-batch.config.json');
const OUTPUT = join(import.meta.dirname, '..', 'output-review-test');

describe('Review Bundle', () => {
  let config = loadConfig(CONFIG_PATH);
  let runId: string;

  beforeAll(async () => {
    config = loadConfig(CONFIG_PATH);
    config.outputDir = OUTPUT;
    mkdirSync(OUTPUT, { recursive: true });

    // Create a run to reference
    const meta = await executeRun('profile', [APO_LIST], config, CONFIG_PATH);
    runId = meta.id;
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) {
      rmSync(OUTPUT, { recursive: true, force: true });
    }
  });

  describe('hashing', () => {
    it('computeFileHash returns consistent SHA-256', () => {
      const hash1 = computeFileHash(APO_LIST);
      const hash2 = computeFileHash(APO_LIST);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64);
    });

    it('computeSchemaFingerprint is deterministic and order-independent', () => {
      const fp1 = computeSchemaFingerprint(['B', 'A', 'C']);
      const fp2 = computeSchemaFingerprint(['C', 'A', 'B']);
      expect(fp1).toBe(fp2);
      expect(fp1).toHaveLength(64);
    });
  });

  describe('CRUD', () => {
    let reviewId: string;

    it('creates a review from a run', async () => {
      const review = await createReview(runId, OUTPUT, config);
      reviewId = review.id;
      expect(review.id).toMatch(/^rev_/);
      expect(review.runId).toBe(runId);
      expect(review.reviewStatus).toBe('draft');
      expect(review.columns.length).toBeGreaterThan(0);
      // Each column should have a suggestion
      for (const col of review.columns) {
        expect(col.suggestion).toBeDefined();
        expect(col.suggestion.fieldFamily).toBeTruthy();
        expect(col.decision).toBe('unknown');
      }
    });

    it('lists reviews', () => {
      const reviews = listReviews(OUTPUT);
      expect(reviews.length).toBeGreaterThan(0);
      expect(reviews[0].id).toBe(reviewId);
    });

    it('gets a review by id', () => {
      const review = getReview(OUTPUT, reviewId);
      expect(review).not.toBeNull();
      expect(review!.id).toBe(reviewId);
    });

    it('updates column reviews', () => {
      const review = getReview(OUTPUT, reviewId)!;
      const firstCol = review.columns[0].sourceColumn;

      const updated = updateReviewColumns(OUTPUT, reviewId, [{
        sourceColumn: firstCol,
        humanSemanticField: 'customer_name',
        humanFieldFamily: 'identity',
        humanSection: 'basic_info',
        decision: 'accepted',
      }]);

      expect(updated).not.toBeNull();
      const col = updated!.columns.find(c => c.sourceColumn === firstCol);
      expect(col!.humanSemanticField).toBe('customer_name');
      expect(col!.decision).toBe('accepted');
    });

    it('updates review summary', () => {
      const updated = updateReviewSummary(OUTPUT, reviewId, {
        primaryFileType: 'apo_list',
        mixedFamilies: ['contact', 'sales_activity'],
        reviewer: 'テスト担当',
        notes: 'テストメモ',
        reviewStatus: 'reviewed',
      });

      expect(updated).not.toBeNull();
      expect(updated!.primaryFileType).toBe('apo_list');
      expect(updated!.mixedFamilies).toContain('contact');
      expect(updated!.reviewer).toBe('テスト担当');
      expect(updated!.reviewStatus).toBe('reviewed');
    });

    it('generates bundle with 4 files', () => {
      const files = generateBundle(OUTPUT, reviewId);
      expect(files).toContain('human-review.json');
      expect(files).toContain('mapping-proposal.json');
      expect(files).toContain('section-layout-proposal.json');
      expect(files).toContain('summary.md');

      // Verify mapping-proposal.json is valid and config-compatible
      const dir = join(OUTPUT, 'reviews', reviewId);
      const mappingProposal = JSON.parse(readFileSync(join(dir, 'mapping-proposal.json'), 'utf-8'));
      expect(mappingProposal.fileName).toBeTruthy();
      expect(mappingProposal.mapping).toBeDefined();
      expect(typeof mappingProposal.mapping).toBe('object');
      expect(mappingProposal.sourceFileHash).toHaveLength(64);

      // Verify summary.md exists and has content
      const summary = readFileSync(join(dir, 'summary.md'), 'utf-8');
      expect(summary).toContain('Review Summary');
      expect(summary).toContain('proposal/candidate');

      // Verify section-layout-proposal.json
      const sectionLayout = JSON.parse(readFileSync(join(dir, 'section-layout-proposal.json'), 'utf-8'));
      expect(sectionLayout.primaryFileType).toBe('apo_list');
      expect(Array.isArray(sectionLayout.sections)).toBe(true);
    });

    it('deletes a review', async () => {
      // Create a throwaway review
      const review = await createReview(runId, OUTPUT, config);
      const deleted = deleteReview(OUTPUT, review.id);
      expect(deleted).toBe(true);
      expect(getReview(OUTPUT, review.id)).toBeNull();
    });
  });
});
