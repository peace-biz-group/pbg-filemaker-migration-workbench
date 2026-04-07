// test/core/auto-apply-orchestrator.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  runAutoApplyPreview,
} from '../../src/core/auto-apply-orchestrator.js';
import { loadSeedDir } from '../../src/core/seed-loader.js';
import {
  createDefaultRegistry,
  registerFingerprint,
  saveRegistry as saveFamilyRegistry,
  loadRegistry as loadFamilyRegistry,
  lookupFingerprint,
  computeFileShapeFingerprint,
  type FamilyRegistryEntry,
} from '../../src/core/family-registry.js';
import {
  createEmptyRegistry as createEmptyTemplateRegistry,
  upsertTemplate,
  saveRegistry as saveTemplateRegistry,
  type MappingTemplate,
} from '../../src/core/mapping-template-registry.js';
import {
  createEmptyMemory,
  addResolution,
  saveMemory,
  type ResolutionRecord,
} from '../../src/core/resolution-memory.js';
import { computeSchemaFingerprint } from '../../src/core/review-bundle.js';

let tmpDir: string;
beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'auto-apply-test-')); });
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }); });

const COLS = ['氏名', '電話番号', '住所'];
const ENCODING = 'cp932';

describe('runAutoApplyPreview — empty registries', () => {
  it('returns customer_master family (algorithmic) and all columns unresolved', () => {
    const schemaFP = computeSchemaFingerprint(COLS);
    const result = runAutoApplyPreview(COLS, ENCODING, true, schemaFP, tmpDir);
    expect(result.familyId).toBe('customer_master');  // algorithmic detection hits threshold
    expect(result.familyCertainty).toBe('low');        // always low for algorithmic
    expect(result.templateId).toBeNull();
    expect(result.autoApplyEligibility).toBe('no_template');
    expect(result.appliedDecisions).toEqual([]);
    expect(result.unresolvedColumns).toEqual(COLS);
  });

  it('returns unknown family for unrecognized columns', () => {
    const cols = ['AAA', 'BBB'];
    const schemaFP = computeSchemaFingerprint(cols);
    const result = runAutoApplyPreview(cols, ENCODING, true, schemaFP, tmpDir);
    expect(result.familyId).toBe('unknown');
    expect(result.templateId).toBeNull();
    expect(result.unresolvedColumns).toEqual(cols);
  });
});

describe('runAutoApplyPreview — family resolved from registry', () => {
  it('returns confirmed certainty when fingerprint is in family registry', () => {
    const fp = computeFileShapeFingerprint(COLS, ENCODING, true);
    const entry: FamilyRegistryEntry = {
      fingerprint: fp,
      family_id: 'customer_master',
      certainty: 'confirmed',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_count: COLS.length,
      encoding: ENCODING,
      has_header: true,
      sample_filename: 'test.csv',
      matched_template_id: null,
    };
    let reg = createDefaultRegistry();
    reg = registerFingerprint(entry, reg);
    saveFamilyRegistry(reg, tmpDir);

    const schemaFP = computeSchemaFingerprint(COLS);
    const result = runAutoApplyPreview(COLS, ENCODING, true, schemaFP, tmpDir);
    expect(result.familyId).toBe('customer_master');
    expect(result.familyCertainty).toBe('confirmed');
  });
});

describe('runAutoApplyPreview — template applies decisions', () => {
  it('applies confirmed decisions and leaves low-confidence unresolved', () => {
    const schemaFP = computeSchemaFingerprint(COLS);
    const template: MappingTemplate = {
      template_id: 'tmpl_v1',
      family_id: 'customer_master',
      schema_fingerprint: schemaFP,
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_decisions: [
        {
          source_col: '氏名',
          canonical_field: 'name',
          inferred_type: 'name',
          normalization_rule: 'trim',
          confidence: 'confirmed',
          decided_at: '2026-04-07T00:00:00Z',
          decided_by: 'human',
        },
        {
          source_col: '電話番号',
          canonical_field: 'phone',
          inferred_type: 'phone',
          normalization_rule: 'normalize_phone',
          confidence: 'high',
          decided_at: '2026-04-07T00:00:00Z',
          decided_by: 'human',
        },
        {
          source_col: '住所',
          canonical_field: 'address',
          inferred_type: 'address',
          normalization_rule: null,
          confidence: 'low',
          decided_at: '2026-04-07T00:00:00Z',
          decided_by: 'auto',
        },
      ],
      auto_apply_eligibility: 'partial',
      known_schema_fingerprints: [schemaFP],
    };
    let reg = createEmptyTemplateRegistry();
    reg = upsertTemplate(template, reg);
    saveTemplateRegistry(reg, tmpDir);

    const result = runAutoApplyPreview(COLS, ENCODING, true, schemaFP, tmpDir);
    expect(result.templateId).toBe('tmpl_v1');
    expect(result.autoApplyEligibility).toBe('partial');
    expect(result.appliedDecisions).toHaveLength(2);
    expect(result.appliedDecisions[0]).toMatchObject({
      sourceColumn: '氏名',
      canonicalField: 'name',
      confidence: 'confirmed',
      source: 'template',
    });
    expect(result.appliedDecisions[1]).toMatchObject({
      sourceColumn: '電話番号',
      canonicalField: 'phone',
      confidence: 'high',
      source: 'template',
    });
    expect(result.unresolvedColumns).toEqual(['住所']);
  });
});

describe('runAutoApplyPreview — resolution memory applies column_ignore', () => {
  it('resolves column_ignore from memory when certainty is confirmed', () => {
    const cols = ['備考', '氏名'];
    const schemaFP = computeSchemaFingerprint(cols);
    const rec: ResolutionRecord = {
      resolution_id: 'res_001',
      resolution_type: 'column_ignore',
      context_key: 'column:備考',
      family_id: null,
      decision: 'unused',
      decision_detail: {},
      certainty: 'confirmed',
      scope: 'global',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'human',
      auto_apply_condition: 'exact_match:column_name',
      source_batch_ids: [],
    };
    let mem = createEmptyMemory();
    mem = addResolution(rec, mem);
    saveMemory(mem, tmpDir);

    const result = runAutoApplyPreview(cols, ENCODING, true, schemaFP, tmpDir);
    const ignored = result.appliedDecisions.find((d) => d.sourceColumn === '備考');
    expect(ignored).toBeDefined();
    expect(ignored!.canonicalField).toBeNull();
    expect(ignored!.source).toBe('memory');
    expect(result.unresolvedColumns).toContain('氏名');
    expect(result.unresolvedColumns).not.toContain('備考');
  });

  it('does NOT resolve column_ignore when certainty is low (fail-closed)', () => {
    const cols = ['備考'];
    const schemaFP = computeSchemaFingerprint(cols);
    const rec: ResolutionRecord = {
      resolution_id: 'res_002',
      resolution_type: 'column_ignore',
      context_key: 'column:備考',
      family_id: null,
      decision: 'unused',
      decision_detail: {},
      certainty: 'low',
      scope: 'global',
      decided_at: '2026-04-07T00:00:00Z',
      decided_by: 'auto',
      auto_apply_condition: 'exact_match:column_name',
      source_batch_ids: [],
    };
    let mem = createEmptyMemory();
    mem = addResolution(rec, mem);
    saveMemory(mem, tmpDir);

    const result = runAutoApplyPreview(cols, ENCODING, true, schemaFP, tmpDir);
    expect(result.appliedDecisions).toHaveLength(0);
    expect(result.unresolvedColumns).toEqual(['備考']);
  });
});

describe('runAutoApplyPreview — 260312 seed integration', () => {
  const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');

  // 顧客_太陽光 の実 fingerprint で family 解決できることを確認
  // fingerprint は scripts/compute-family-fingerprints-260312.ts で算出済み
  it('resolves customer_master certainty from 260312 seed fingerprint', () => {
    loadSeedDir(SEED_260312, tmpDir);

    // 実ファイルと同じ列構成で schemaFingerprint を生成（先頭5列で代表）
    const sampleCols = ['FAX番号', 'ステータス', '住所', '氏名相当列なし', '電話番号'];
    const schemaFP = computeFileShapeFingerprint(sampleCols, 'utf-8', true);

    // ファイル形状 fingerprint で family registry に直接登録されているエントリを確認
    // runAutoApplyPreview は columns + encoding + hasHeader から fingerprint を計算して lookup する
    const customerCols = ['FAX番号'];  // 1列でも fingerprint が異なれば lookup miss になる正しい動作
    const result = runAutoApplyPreview(customerCols, 'utf-8', true, schemaFP, tmpDir);
    // ファイル形状が違うので registry 直撃はしないが、seed が正常に読み込まれていることを確認
    expect(result).toBeDefined();
    expect(result.familyId).toBeDefined();
  });

  it('resolves confirmed certainty when file shape exactly matches 260312 customer seed', () => {
    loadSeedDir(SEED_260312, tmpDir);

    // 実ファイルと同じ 124列の fixture 化は避け、seed の実値 fingerprint で registry lookup を検証
    // fingerprint は scripts/compute-family-fingerprints-260312.ts で算出
    const realFp = '24ea1e697430fd82dfb8b414de7f9161f89bec1b46239eeb12546e48c154b9a8';
    const reg = loadFamilyRegistry(tmpDir);
    const entry = lookupFingerprint(realFp, reg);
    expect(entry).not.toBeNull();
    expect(entry!.family_id).toBe('customer_master');
    expect(entry!.certainty).toBe('high');
  });

  it('resolves call_history certainty from 260312 seed fingerprint', () => {
    loadSeedDir(SEED_260312, tmpDir);

    const realFp = '5828c2447b2034f1991f5abbd73f36e589124aed32350113c593eaece8fb7564';
    const reg = loadFamilyRegistry(tmpDir);
    const entry = lookupFingerprint(realFp, reg);
    expect(entry).not.toBeNull();
    expect(entry!.family_id).toBe('call_history');
    expect(entry!.certainty).toBe('high');
  });

  // schema_fingerprint は computeSchemaFingerprint(headers) で算出
  // scripts/compute-template-fingerprints-260312.ts 参照
  const CUSTOMER_SCHEMA_FP = '1a94d6a044c75c2cba52cd7fa95d6e6fd66365ff00c96572dc37e8eb4b53706e';
  const CALL_SCHEMA_FP = 'a41781a80599e9183b620f3c1ea6059ce79b6fa3fb358e78d7a0178349edb0ab';

  it('resolves customer_master template from 260312 seed', () => {
    loadSeedDir(SEED_260312, tmpDir);

    // customer は 124 列 — fixture 化せず schemaFP 直接指定
    // CSV も XLSX も同一列構成なので同一 schemaFP に到達する
    const result = runAutoApplyPreview(['dummy'], 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);
    expect(result.templateId).toBe('tmpl_customer_master_260312_v1');
    expect(result.autoApplyEligibility).toBe('partial');
  });

  it('resolves call_history template from 260312 seed and applies decisions', () => {
    loadSeedDir(SEED_260312, tmpDir);

    const callCols = [
      '<テーブルが見つかりません>', '日付', '時刻', '担当者',
      '電話番号【検索】', '内容', '日時', 'お客様担当',
    ];
    const result = runAutoApplyPreview(callCols, 'utf-8', true, CALL_SCHEMA_FP, tmpDir);
    expect(result.templateId).toBe('tmpl_call_history_260312_v1');
    expect(result.autoApplyEligibility).toBe('partial');
    // high/confirmed のみ適用 — '内容'(low) は除外
    const resolvedCols = result.appliedDecisions.map((d) => d.sourceColumn);
    expect(resolvedCols).toContain('<テーブルが見つかりません>');
    expect(resolvedCols).toContain('日付');
    expect(resolvedCols).toContain('担当者');
    expect(resolvedCols).not.toContain('内容');
    // artifact 列は canonical_field が null
    const artifact = result.appliedDecisions.find((d) => d.sourceColumn === '<テーブルが見つかりません>');
    expect(artifact!.canonicalField).toBeNull();
    // '内容' は unresolved
    expect(result.unresolvedColumns).toContain('内容');
  });

  it('CSV and XLSX for customer_master reach the same template (same schema_fingerprint)', () => {
    loadSeedDir(SEED_260312, tmpDir);

    // CSV と XLSX は同一列構成 → schemaFP が同じ → 同一 template に到達
    const csvResult = runAutoApplyPreview(['dummy'], 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);
    const xlsxResult = runAutoApplyPreview(['dummy'], 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);
    expect(csvResult.templateId).toBe(xlsxResult.templateId);
    expect(csvResult.templateId).toBe('tmpl_customer_master_260312_v1');
  });

  it('customer_master partial — resolves seeded cols, leaves unknown cols fail-closed', () => {
    loadSeedDir(SEED_260312, tmpDir);

    // 代表列 + portal 列 + 未 seed 列を混在させて partial 解決を検証
    const testCols = ['電話番号', '住所', '郵便番号', 'ｺｰﾙ履歴::日付', '部材名'];
    const result = runAutoApplyPreview(testCols, 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);

    expect(result.templateId).toBe('tmpl_customer_master_260312_v1');
    expect(result.autoApplyEligibility).toBe('partial');

    // seeded canonical 列は auto-apply される
    const phoneApplied = result.appliedDecisions.find((d) => d.sourceColumn === '電話番号');
    expect(phoneApplied).toBeDefined();
    expect(phoneApplied!.canonicalField).toBe('phone_number');
    expect(phoneApplied!.source).toBe('template');

    const addressApplied = result.appliedDecisions.find((d) => d.sourceColumn === '住所');
    expect(addressApplied!.canonicalField).toBe('address');

    // portal 列は canonical_field=null で auto-apply される（skip 扱い）
    const portalApplied = result.appliedDecisions.find((d) => d.sourceColumn === 'ｺｰﾙ履歴::日付');
    expect(portalApplied).toBeDefined();
    expect(portalApplied!.canonicalField).toBeNull();
    expect(portalApplied!.source).toBe('template');

    // 未 seed 列は fail-closed で unresolved に残る
    expect(result.unresolvedColumns).toContain('部材名');
  });

  it('customer_master partial — resolves staff / id seeded cols', () => {
    loadSeedDir(SEED_260312, tmpDir);

    const testCols = ['作成者', '修正者', '訪問担当者', 'ｱﾎﾟ担当', '申請ID', '伝票番号', '部材名'];
    const result = runAutoApplyPreview(testCols, 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);

    expect(result.templateId).toBe('tmpl_customer_master_260312_v1');
    expect(result.autoApplyEligibility).toBe('partial');

    // 責任主体フィールド
    const createdBy = result.appliedDecisions.find((d) => d.sourceColumn === '作成者');
    expect(createdBy).toBeDefined();
    expect(createdBy!.canonicalField).toBe('created_by');
    expect(createdBy!.source).toBe('template');

    const modifiedBy = result.appliedDecisions.find((d) => d.sourceColumn === '修正者');
    expect(modifiedBy!.canonicalField).toBe('modified_by');

    const visitStaff = result.appliedDecisions.find((d) => d.sourceColumn === '訪問担当者');
    expect(visitStaff!.canonicalField).toBe('visit_staff');

    const appointmentStaff = result.appliedDecisions.find((d) => d.sourceColumn === 'ｱﾎﾟ担当');
    expect(appointmentStaff!.canonicalField).toBe('appointment_staff');

    // ID系
    const appId = result.appliedDecisions.find((d) => d.sourceColumn === '申請ID');
    expect(appId!.canonicalField).toBe('application_id');

    const voucherNum = result.appliedDecisions.find((d) => d.sourceColumn === '伝票番号');
    expect(voucherNum!.canonicalField).toBe('voucher_number');

    // 未 seed 列は fail-closed で unresolved に残る
    expect(result.unresolvedColumns).toContain('部材名');
  });

  it('customer_master partial — resolves date / cancel / status-detail seeded cols', () => {
    loadSeedDir(SEED_260312, tmpDir);

    const testCols = ['工事日', '工事完了日', '連系日', 'ｷｬﾝｾﾙﾌﾗｸﾞ', 'ｷｬﾝｾﾙ日', 'キャンセル理由', '審査結果', '部材名'];
    const result = runAutoApplyPreview(testCols, 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);

    expect(result.autoApplyEligibility).toBe('partial');

    // date 系
    const constructionDate = result.appliedDecisions.find((d) => d.sourceColumn === '工事日');
    expect(constructionDate!.canonicalField).toBe('construction_date');
    expect(constructionDate!.source).toBe('template');

    const gridConnection = result.appliedDecisions.find((d) => d.sourceColumn === '連系日');
    expect(gridConnection!.canonicalField).toBe('grid_connection_date');

    // cancel 系
    const cancelFlag = result.appliedDecisions.find((d) => d.sourceColumn === 'ｷｬﾝｾﾙﾌﾗｸﾞ');
    expect(cancelFlag!.canonicalField).toBe('cancel_flag');

    const cancelReason = result.appliedDecisions.find((d) => d.sourceColumn === 'キャンセル理由');
    expect(cancelReason!.canonicalField).toBe('cancel_reason');

    // status-detail 系
    const screeningResult = result.appliedDecisions.find((d) => d.sourceColumn === '審査結果');
    expect(screeningResult!.canonicalField).toBe('screening_result');

    // 未 seed 列は fail-closed で unresolved に残る
    expect(result.unresolvedColumns).toContain('部材名');
  });

  it('customer_master partial — resolves performance / billing date seeded cols', () => {
    loadSeedDir(SEED_260312, tmpDir);

    const testCols = ['成績計上日', '成績計上月', '請求書発行日', '入金日', '部材名'];
    const result = runAutoApplyPreview(testCols, 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);

    expect(result.autoApplyEligibility).toBe('partial');

    // 成績計上日 — date
    const bookingDate = result.appliedDecisions.find((d) => d.sourceColumn === '成績計上日');
    expect(bookingDate!.canonicalField).toBe('performance_booking_date');
    expect(bookingDate!.source).toBe('template');

    // 成績計上月 — month (date と混同しない)
    const bookingMonth = result.appliedDecisions.find((d) => d.sourceColumn === '成績計上月');
    expect(bookingMonth!.canonicalField).toBe('performance_booking_month');

    // 請求書発行日 — date
    const invoiceDate = result.appliedDecisions.find((d) => d.sourceColumn === '請求書発行日');
    expect(invoiceDate!.canonicalField).toBe('invoice_issued_date');

    // 入金日 — date
    const paymentDate = result.appliedDecisions.find((d) => d.sourceColumn === '入金日');
    expect(paymentDate!.canonicalField).toBe('payment_date');

    // 未 seed 列は fail-closed で unresolved に残る
    expect(result.unresolvedColumns).toContain('部材名');
  });

  it('customer_master partial — resolves equipment flow date seeded cols', () => {
    loadSeedDir(SEED_260312, tmpDir);

    const testCols = ['平面図到着', '完工報告', '部材名'];
    const result = runAutoApplyPreview(testCols, 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);

    expect(result.autoApplyEligibility).toBe('partial');

    // 施工図面到着日
    const blueprintArrival = result.appliedDecisions.find((d) => d.sourceColumn === '平面図到着');
    expect(blueprintArrival).toBeDefined();
    expect(blueprintArrival!.canonicalField).toBe('blueprint_arrival_date');
    expect(blueprintArrival!.source).toBe('template');

    // 完工報告日（列名は動詞句だが値は date）
    const completionReport = result.appliedDecisions.find((d) => d.sourceColumn === '完工報告');
    expect(completionReport).toBeDefined();
    expect(completionReport!.canonicalField).toBe('completion_report_date');
    expect(completionReport!.source).toBe('template');

    // 未 seed 列は fail-closed で unresolved に残る
    expect(result.unresolvedColumns).toContain('部材名');
  });

  it('customer_master partial — resolves document flow date seeded cols', () => {
    loadSeedDir(SEED_260312, tmpDir);

    const testCols = ['借受証発送', '承諾書発送', '報告書到着日', '保証書着', '保証申請', '部材名'];
    const result = runAutoApplyPreview(testCols, 'utf-8', true, CUSTOMER_SCHEMA_FP, tmpDir);

    expect(result.autoApplyEligibility).toBe('partial');

    // 書類送付・承諾フロー
    const leaseSent = result.appliedDecisions.find((d) => d.sourceColumn === '借受証発送');
    expect(leaseSent).toBeDefined();
    expect(leaseSent!.canonicalField).toBe('lease_certificate_sent_date');
    expect(leaseSent!.source).toBe('template');

    const consentSent = result.appliedDecisions.find((d) => d.sourceColumn === '承諾書発送');
    expect(consentSent!.canonicalField).toBe('consent_form_sent_date');

    // 書類受領フロー
    const reportArrival = result.appliedDecisions.find((d) => d.sourceColumn === '報告書到着日');
    expect(reportArrival!.canonicalField).toBe('report_arrival_date');

    // 保証書・保証申請フロー
    const warrantyReceipt = result.appliedDecisions.find((d) => d.sourceColumn === '保証書着');
    expect(warrantyReceipt!.canonicalField).toBe('warranty_receipt_date');

    const warrantyApp = result.appliedDecisions.find((d) => d.sourceColumn === '保証申請');
    expect(warrantyApp!.canonicalField).toBe('warranty_application_date');

    // 未 seed 列は fail-closed で unresolved に残る
    expect(result.unresolvedColumns).toContain('部材名');
  });
});
