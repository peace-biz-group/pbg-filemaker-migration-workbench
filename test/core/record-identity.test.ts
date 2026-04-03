import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { loadConfig } from '../../src/config/defaults.js';
import { buildRecordIdentity } from '../../src/core/record-identity.js';
import { normalizeFile } from '../../src/core/normalizer.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parse as parseCsvSync } from 'csv-parse/sync';

function config() {
  const cfg = loadConfig();
  cfg.identityStrategies = {
    'apo*.csv': {
      recordFamily: 'apo_list',
      nativeIdField: 'fm_record_id',
      deterministicFields: ['customer_name', 'phone', 'activity_date'],
      entityMatchFields: ['customer_name', 'phone'],
    },
    'call_activity*.csv': {
      recordFamily: 'call_activity',
      deterministicFields: ['customer_name', 'phone', 'activity_date', 'operator', 'result_code'],
      mainlineFingerprintFields: ['customer_name', 'phone', 'activity_date', 'operator', 'result_code'],
    },
    'visit_activity*.csv': {
      recordFamily: 'visit_activity',
      deterministicFields: ['customer_name', 'phone', 'activity_date', 'operator', 'visit_type', 'result_code'],
      mainlineFingerprintFields: ['customer_name', 'phone', 'activity_date', 'operator', 'visit_type', 'result_code'],
    },
    'retry_followup*.csv': {
      recordFamily: 'retry_followup',
      deterministicFields: ['customer_name', 'phone', 'scheduled_followup_date', 'retry_date', 'operator', 'retry_status'],
      mainlineFingerprintFields: ['customer_name', 'phone', 'scheduled_followup_date', 'retry_date', 'operator', 'retry_status', 'outcome'],
    },
    'customer*.csv': {
      recordFamily: 'customer_master_like',
      deterministicFields: ['customer_name', 'company_name', 'phone'],
      entityMatchFields: ['customer_name', 'company_name', 'phone'],
      mainlineFingerprintFields: ['customer_name', 'company_name', 'phone', 'email', 'address'],
    },
  };
  return cfg;
}

describe('record identity', () => {
  let outDir: string;
  const fixtures = join(import.meta.dirname, '..', 'fixtures', 'identity');
  const activityFixtures = join(fixtures, 'activity');
  beforeEach(() => {
    outDir = mkdtempSync(join(tmpdir(), 'identity-golden-'));
  });
  afterEach(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  async function normalizedRows(file: string) {
    const cfg = config();
    cfg.outputDir = outDir;
    await normalizeFile(file, cfg, { sourceBatchId: 'b', importRunId: 'r', sourceKey: 's', sourceMode: 'mainline' });
    const normalizedPath = join(outDir, 'normalized.csv');
    return parseCsvSync(readFileSync(normalizedPath, 'utf-8'), { columns: true, skip_empty_lines: true, bom: true }) as Array<Record<string, string>>;
  }

  it('同一CSV再投入で source_record_key が安定', () => {
    const cfg = config();
    const record = { customer_name: '田中', phone: '0312345678', activity_date: '2026-01-01' };
    const id1 = buildRecordIdentity(record, { sourceFile: 'apo_1.csv', mode: 'mainline' }, cfg);
    const id2 = buildRecordIdentity(record, { sourceFile: 'apo_1.csv', mode: 'mainline' }, cfg);
    expect(id1.sourceRecordKey).toBe(id2.sourceRecordKey);
  });

  it('並び順だけが違っても structural/source key は安定', () => {
    const cfg = config();
    const a = { customer_name: '田中', phone: '0312345678', activity_date: '2026-01-01' };
    const b = { activity_date: '2026-01-01', phone: '0312345678', customer_name: '田中' };
    const idA = buildRecordIdentity(a, { sourceFile: 'apo_1.csv', mode: 'mainline' }, cfg);
    const idB = buildRecordIdentity(b, { sourceFile: 'apo_1.csv', mode: 'mainline' }, cfg);
    expect(idA.structuralFingerprint).toBe(idB.structuralFingerprint);
    expect(idA.sourceRecordKey).toBe(idB.sourceRecordKey);
  });

  it('fallback method は mainline_ready にならない', () => {
    const cfg = config();
    const id = buildRecordIdentity({}, { sourceFile: 'apo_1.csv', mode: 'mainline' }, cfg);
    expect(id.sourceRecordKeyMethod).toBe('fallback');
    expect(id.mergeEligibility).toBe('review');
  });

  it('customer_master_like + semantic owner unknown は review', () => {
    const cfg = config();
    const id = buildRecordIdentity({}, { sourceFile: 'customer.csv', mode: 'mainline' }, cfg);
    expect(id.semanticOwner).toBe('unknown');
    expect(id.mergeEligibility).toBe('review');
  });

  it('archive mode は常に archive_only', () => {
    const cfg = config();
    const id = buildRecordIdentity({ fm_record_id: '1' }, { sourceFile: 'apo_1.csv', mode: 'archive' }, cfg);
    expect(id.mergeEligibility).toBe('archive_only');
  });

  it('golden: 行順だけ変更しても source_record_key は不変', async () => {
    const a = await normalizedRows(join(fixtures, 'customer_order_a.csv'));
    const b = await normalizedRows(join(fixtures, 'customer_order_rows_swapped.csv'));
    const keysA = new Set(a.map(r => r._source_record_key));
    const keysB = new Set(b.map(r => r._source_record_key));
    expect(keysA).toEqual(keysB);
  });

  it('golden: 列順だけ変更しても source_record_key は不変', async () => {
    const a = await normalizedRows(join(fixtures, 'customer_order_a.csv'));
    const b = await normalizedRows(join(fixtures, 'customer_order_columns_swapped.csv'));
    expect(new Set(a.map(r => r._source_record_key))).toEqual(new Set(b.map(r => r._source_record_key)));
  });

  it('golden: 非 mainline 列変更では mainline fingerprint は不変', async () => {
    const a = await normalizedRows(join(fixtures, 'customer_order_a.csv'));
    const b = await normalizedRows(join(fixtures, 'customer_non_mainline_changed.csv'));
    const first = a.find(r => r.customer_name === '田中太郎')!;
    const changed = b.find(r => r.customer_name === '田中太郎')!;
    expect(first._structural_fingerprint_full).not.toBe(changed._structural_fingerprint_full);
    expect(first._structural_fingerprint_mainline).toBe(changed._structural_fingerprint_mainline);
  });

  it('call_activity: 行順変更で source_record_key は不変', async () => {
    const a = await normalizedRows(join(activityFixtures, 'call_activity_row_a.csv'));
    const b = await normalizedRows(join(activityFixtures, 'call_activity_row_swapped.csv'));
    expect(new Set(a.map(r => r._source_record_key))).toEqual(new Set(b.map(r => r._source_record_key)));
  });

  it('visit_activity: 列順変更で source_record_key は不変', async () => {
    const a = await normalizedRows(join(activityFixtures, 'visit_activity_col_a.csv'));
    const b = await normalizedRows(join(activityFixtures, 'visit_activity_col_swapped.csv'));
    expect(new Set(a.map(r => r._source_record_key))).toEqual(new Set(b.map(r => r._source_record_key)));
  });

  it('retry_followup: 行順変更で source_record_key は不変', async () => {
    const a = await normalizedRows(join(activityFixtures, 'retry_followup_row_a.csv'));
    const b = await normalizedRows(join(activityFixtures, 'retry_followup_row_swapped.csv'));
    expect(new Set(a.map(r => r._source_record_key))).toEqual(new Set(b.map(r => r._source_record_key)));
  });

  it('activity識別不足は review + activity_timestamp_insufficient', async () => {
    const callRows = await normalizedRows(join(activityFixtures, 'call_activity_date_only.csv'));
    expect(callRows[0]?._merge_eligibility).toBe('review');
    expect(callRows[0]?._review_reason).toBe('activity_timestamp_insufficient');

    const visitRows = await normalizedRows(join(activityFixtures, 'visit_activity_timestamp_insufficient.csv'));
    expect(visitRows[0]?._merge_eligibility).toBe('review');
    expect(visitRows[0]?._review_reason).toBe('activity_timestamp_insufficient');

    const retryRows = await normalizedRows(join(activityFixtures, 'retry_followup_weak_identifier.csv'));
    expect(retryRows[0]?._merge_eligibility).toBe('review');
    expect(retryRows[0]?._review_reason).toBe('activity_timestamp_insufficient');
  });

  it('apo_list: 列順変更でも source_record_key 不変', async () => {
    const a = await normalizedRows(join(activityFixtures, 'apo_list_col_a.csv'));
    const b = await normalizedRows(join(activityFixtures, 'apo_list_col_swapped.csv'));
    expect(a[0]?._source_record_key).toBe(b[0]?._source_record_key);
  });

  it('apo_list: 非 mainline 列変更では mainline fingerprint 不変', async () => {
    const a = await normalizedRows(join(activityFixtures, 'apo_list_col_a.csv'));
    const b = await normalizedRows(join(activityFixtures, 'apo_list_non_mainline_changed.csv'));
    expect(a[0]?._structural_fingerprint_mainline).toBe(b[0]?._structural_fingerprint_mainline);
    expect(a[0]?._structural_fingerprint_full).not.toBe(b[0]?._structural_fingerprint_full);
  });
});
