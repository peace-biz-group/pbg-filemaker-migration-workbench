// test/core/seed-loader.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadSeedDir } from '../../src/core/seed-loader.js';
import { loadRegistry as loadFamilyRegistry, lookupFingerprint } from '../../src/core/family-registry.js';
import { loadRegistry as loadTemplateRegistry, getTemplate } from '../../src/core/mapping-template-registry.js';
import { loadMemory, lookupResolution } from '../../src/core/resolution-memory.js';
import type { FamilyRegistryEntry } from '../../src/core/family-registry.js';
import type { MappingTemplate } from '../../src/core/mapping-template-registry.js';
import type { ResolutionRecord } from '../../src/core/resolution-memory.js';

let seedDir: string;
let outputDir: string;
beforeEach(() => {
  seedDir = mkdtempSync(join(tmpdir(), 'seed-loader-seed-'));
  outputDir = mkdtempSync(join(tmpdir(), 'seed-loader-out-'));
});
afterEach(() => {
  rmSync(seedDir, { recursive: true, force: true });
  rmSync(outputDir, { recursive: true, force: true });
});

function writeSeed<T>(filename: string, data: T[]): void {
  writeFileSync(join(seedDir, filename), JSON.stringify(data, null, 2), 'utf-8');
}

describe('loadSeedDir — families.json', () => {
  it('loads FamilyRegistryEntry array into family registry', () => {
    const entry: FamilyRegistryEntry = {
      fingerprint: 'fp_seed_001',
      family_id: 'customer_master',
      certainty: 'high',
      confirmed_at: null,
      column_count: 3,
      encoding: 'cp932',
      has_header: true,
      sample_filename: '260312_顧客.csv',
      matched_template_id: null,
    };
    writeSeed('families.json', [entry]);

    const result = loadSeedDir(seedDir, outputDir);
    expect(result.familiesLoaded).toBe(1);

    const reg = loadFamilyRegistry(outputDir);
    const found = lookupFingerprint('fp_seed_001', reg);
    expect(found).not.toBeNull();
    expect(found!.family_id).toBe('customer_master');
  });

  it('skips families.json if file does not exist', () => {
    writeSeed('templates.json', []);
    writeSeed('memories.json', []);
    const result = loadSeedDir(seedDir, outputDir);
    expect(result.familiesLoaded).toBe(0);
  });
});

describe('loadSeedDir — templates.json', () => {
  it('loads MappingTemplate array into template registry', () => {
    const template: MappingTemplate = {
      template_id: 'seed_tmpl_v1',
      family_id: 'customer_master',
      schema_fingerprint: 'fp_schema_001',
      version: 1,
      created_at: '2026-04-07T00:00:00Z',
      confirmed_at: null,
      column_decisions: [],
      auto_apply_eligibility: 'review_required',
      known_schema_fingerprints: ['fp_schema_001'],
    };
    writeSeed('templates.json', [template]);

    const result = loadSeedDir(seedDir, outputDir);
    expect(result.templatesLoaded).toBe(1);

    const reg = loadTemplateRegistry(outputDir);
    expect(getTemplate('fp_schema_001', reg)!.template_id).toBe('seed_tmpl_v1');
  });
});

describe('loadSeedDir — memories.json', () => {
  it('loads ResolutionRecord array into resolution memory', () => {
    const rec: ResolutionRecord = {
      resolution_id: 'seed_res_001',
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
    writeSeed('memories.json', [rec]);

    const result = loadSeedDir(seedDir, outputDir);
    expect(result.memoriesLoaded).toBe(1);

    const mem = loadMemory(outputDir);
    const found = lookupResolution('column_ignore', 'column:備考', mem);
    expect(found!.resolution_id).toBe('seed_res_001');
  });
});

describe('loadSeedDir — merge semantics', () => {
  it('merges into existing registries without losing existing entries', () => {
    // First load
    const existing: FamilyRegistryEntry = {
      fingerprint: 'fp_existing',
      family_id: 'call_history',
      certainty: 'confirmed',
      confirmed_at: '2026-04-07T00:00:00Z',
      column_count: 2,
      encoding: 'utf-8',
      has_header: true,
      sample_filename: 'existing.csv',
      matched_template_id: null,
    };
    writeSeed('families.json', [existing]);
    loadSeedDir(seedDir, outputDir);

    // Second load with different seed dir
    const seedDir2 = mkdtempSync(join(tmpdir(), 'seed-loader-seed2-'));
    const newEntry: FamilyRegistryEntry = {
      fingerprint: 'fp_new',
      family_id: 'customer_master',
      certainty: 'high',
      confirmed_at: null,
      column_count: 5,
      encoding: 'cp932',
      has_header: true,
      sample_filename: 'new.csv',
      matched_template_id: null,
    };
    writeFileSync(join(seedDir2, 'families.json'), JSON.stringify([newEntry], null, 2), 'utf-8');
    loadSeedDir(seedDir2, outputDir);
    rmSync(seedDir2, { recursive: true, force: true });

    const reg = loadFamilyRegistry(outputDir);
    expect(lookupFingerprint('fp_existing', reg)).not.toBeNull();
    expect(lookupFingerprint('fp_new', reg)).not.toBeNull();
  });
});

describe('loadSeedDir — real data/seeds/260312 stubs', () => {
  it('loads the bundled 260312 seed stubs without error', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    const result = loadSeedDir(SEED_260312, outputDir);
    expect(result.familiesLoaded).toBeGreaterThanOrEqual(0);
    expect(result.templatesLoaded).toBeGreaterThanOrEqual(0);
    expect(result.memoriesLoaded).toBeGreaterThanOrEqual(0);
  });

  // 実値 fingerprint 検証 — computeFileShapeFingerprint で算出した実値が seed に反映済みであることを確認
  it('resolves customer_master from 260312 real fingerprint (顧客_太陽光)', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadFamilyRegistry(outputDir);
    // fingerprint は scripts/compute-family-fingerprints-260312.ts で算出
    const entry = lookupFingerprint(
      '24ea1e697430fd82dfb8b414de7f9161f89bec1b46239eeb12546e48c154b9a8',
      reg,
    );
    expect(entry).not.toBeNull();
    expect(entry!.family_id).toBe('customer_master');
    expect(entry!.column_count).toBe(124);
    expect(entry!.encoding).toBe('utf-8');
  });

  it('resolves call_history from 260312 real fingerprint (コール履歴_太陽光)', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadFamilyRegistry(outputDir);
    const entry = lookupFingerprint(
      '5828c2447b2034f1991f5abbd73f36e589124aed32350113c593eaece8fb7564',
      reg,
    );
    expect(entry).not.toBeNull();
    expect(entry!.family_id).toBe('call_history');
    expect(entry!.column_count).toBe(8);
    expect(entry!.encoding).toBe('utf-8');
  });

  // schema_fingerprint は scripts/compute-template-fingerprints-260312.ts で算出
  it('resolves customer_master template from 260312 seed (schema_fingerprint lookup)', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadTemplateRegistry(outputDir);
    const template = getTemplate(
      '1a94d6a044c75c2cba52cd7fa95d6e6fd66365ff00c96572dc37e8eb4b53706e',
      reg,
    );
    expect(template).not.toBeNull();
    expect(template!.template_id).toBe('tmpl_customer_master_260312_v1');
    expect(template!.family_id).toBe('customer_master');
    expect(template!.auto_apply_eligibility).toBe('partial');
  });

  it('resolves call_history template from 260312 seed (schema_fingerprint lookup)', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadTemplateRegistry(outputDir);
    const template = getTemplate(
      'a41781a80599e9183b620f3c1ea6059ce79b6fa3fb358e78d7a0178349edb0ab',
      reg,
    );
    expect(template).not.toBeNull();
    expect(template!.template_id).toBe('tmpl_call_history_260312_v1');
    expect(template!.family_id).toBe('call_history');
    expect(template!.auto_apply_eligibility).toBe('partial');
    expect(template!.column_decisions).toHaveLength(8);
    const artifactDecision = template!.column_decisions.find(
      (d) => d.source_col === '<テーブルが見つかりません>',
    );
    expect(artifactDecision!.canonical_field).toBeNull();
    expect(artifactDecision!.inferred_type).toBe('artifact');
  });

  it('customer_master template has expanded column decisions with representative fields', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadTemplateRegistry(outputDir);
    const template = getTemplate(
      '1a94d6a044c75c2cba52cd7fa95d6e6fd66365ff00c96572dc37e8eb4b53706e',
      reg,
    );
    expect(template).not.toBeNull();
    // 51（前回）+ 8（人系・ID系）+ 4（成績・請求系）= 63
    expect(template!.column_decisions.length).toBeGreaterThanOrEqual(63);

    // 代表 canonical 列が正しく seeded されているか
    const phone = template!.column_decisions.find((d) => d.source_col === '電話番号');
    expect(phone!.canonical_field).toBe('phone_number');
    expect(phone!.inferred_type).toBe('phone');
    expect(phone!.confidence).toBe('high');

    const address = template!.column_decisions.find((d) => d.source_col === '住所');
    expect(address!.canonical_field).toBe('address');

    const postalCode = template!.column_decisions.find((d) => d.source_col === '郵便番号');
    expect(postalCode!.canonical_field).toBe('postal_code');

    // portal 列は canonical_field が null
    const portalCol = template!.column_decisions.find((d) => d.source_col === 'ｺｰﾙ履歴::日付');
    expect(portalCol!.canonical_field).toBeNull();
    expect(portalCol!.inferred_type).toBe('portal');
    expect(portalCol!.confidence).toBe('high');
  });

  it('customer_master template has staff / id seed columns', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadTemplateRegistry(outputDir);
    const template = getTemplate(
      '1a94d6a044c75c2cba52cd7fa95d6e6fd66365ff00c96572dc37e8eb4b53706e',
      reg,
    );
    expect(template).not.toBeNull();

    // 責任主体フィールド（作成者・修正者）
    const createdBy = template!.column_decisions.find((d) => d.source_col === '作成者');
    expect(createdBy!.canonical_field).toBe('created_by');
    expect(createdBy!.inferred_type).toBe('staff');
    expect(createdBy!.confidence).toBe('high');

    const modifiedBy = template!.column_decisions.find((d) => d.source_col === '修正者');
    expect(modifiedBy!.canonical_field).toBe('modified_by');
    expect(modifiedBy!.inferred_type).toBe('staff');
    expect(modifiedBy!.confidence).toBe('high');

    // 担当者系
    const visitStaff = template!.column_decisions.find((d) => d.source_col === '訪問担当者');
    expect(visitStaff!.canonical_field).toBe('visit_staff');
    expect(visitStaff!.inferred_type).toBe('name');

    const appointmentStaff = template!.column_decisions.find((d) => d.source_col === 'ｱﾎﾟ担当');
    expect(appointmentStaff!.canonical_field).toBe('appointment_staff');
    expect(appointmentStaff!.inferred_type).toBe('name');

    const staffPhonetic = template!.column_decisions.find((d) => d.source_col === '担当者ﾌﾘｶﾞﾅ');
    expect(staffPhonetic!.canonical_field).toBe('staff_name_phonetic');

    const repPhonetic = template!.column_decisions.find((d) => d.source_col === '代表者ﾌﾘｶﾞﾅ');
    expect(repPhonetic!.canonical_field).toBe('representative_name_phonetic');

    // ID系
    const appId = template!.column_decisions.find((d) => d.source_col === '申請ID');
    expect(appId!.canonical_field).toBe('application_id');
    expect(appId!.inferred_type).toBe('id');
    expect(appId!.confidence).toBe('high');

    const voucherNum = template!.column_decisions.find((d) => d.source_col === '伝票番号');
    expect(voucherNum!.canonical_field).toBe('voucher_number');
    expect(voucherNum!.inferred_type).toBe('id');
    expect(voucherNum!.confidence).toBe('high');
  });

  it('customer_master template has date / cancel / status-detail seed columns', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadTemplateRegistry(outputDir);
    const template = getTemplate(
      '1a94d6a044c75c2cba52cd7fa95d6e6fd66365ff00c96572dc37e8eb4b53706e',
      reg,
    );
    expect(template).not.toBeNull();

    // date 系
    const constructionDate = template!.column_decisions.find((d) => d.source_col === '工事日');
    expect(constructionDate!.canonical_field).toBe('construction_date');
    expect(constructionDate!.inferred_type).toBe('date');

    const gridConnection = template!.column_decisions.find((d) => d.source_col === '連系日');
    expect(gridConnection!.canonical_field).toBe('grid_connection_date');
    expect(gridConnection!.inferred_type).toBe('date');

    const cancelDate = template!.column_decisions.find((d) => d.source_col === 'ｷｬﾝｾﾙ日');
    expect(cancelDate!.canonical_field).toBe('cancel_date');

    // cancel 系
    const cancelFlag = template!.column_decisions.find((d) => d.source_col === 'ｷｬﾝｾﾙﾌﾗｸﾞ');
    expect(cancelFlag!.canonical_field).toBe('cancel_flag');
    expect(cancelFlag!.inferred_type).toBe('bool');

    const cancelReason = template!.column_decisions.find((d) => d.source_col === 'キャンセル理由');
    expect(cancelReason!.canonical_field).toBe('cancel_reason');

    // status-detail 系
    const screeningResult = template!.column_decisions.find((d) => d.source_col === '審査結果');
    expect(screeningResult!.canonical_field).toBe('screening_result');
    expect(screeningResult!.inferred_type).toBe('status');
  });

  it('customer_master template has equipment flow date seed columns', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadTemplateRegistry(outputDir);
    const template = getTemplate(
      '1a94d6a044c75c2cba52cd7fa95d6e6fd66365ff00c96572dc37e8eb4b53706e',
      reg,
    );
    expect(template).not.toBeNull();

    // 平面図到着 — 施工図面の到着日（設備フロー前準備）
    const blueprintArrival = template!.column_decisions.find((d) => d.source_col === '平面図到着');
    expect(blueprintArrival!.canonical_field).toBe('blueprint_arrival_date');
    expect(blueprintArrival!.inferred_type).toBe('date');
    expect(blueprintArrival!.confidence).toBe('high');
    expect(blueprintArrival!.normalization_rule).toBe('normalize_date');

    // 完工報告 — 工事完了報告日（列名は動詞句だが値は date）
    const completionReport = template!.column_decisions.find((d) => d.source_col === '完工報告');
    expect(completionReport!.canonical_field).toBe('completion_report_date');
    expect(completionReport!.inferred_type).toBe('date');
    expect(completionReport!.confidence).toBe('high');
    expect(completionReport!.normalization_rule).toBe('normalize_date');
  });

  it('customer_master template has performance / billing date seed columns', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadTemplateRegistry(outputDir);
    const template = getTemplate(
      '1a94d6a044c75c2cba52cd7fa95d6e6fd66365ff00c96572dc37e8eb4b53706e',
      reg,
    );
    expect(template).not.toBeNull();

    // 成績計上日 — date
    const bookingDate = template!.column_decisions.find((d) => d.source_col === '成績計上日');
    expect(bookingDate!.canonical_field).toBe('performance_booking_date');
    expect(bookingDate!.inferred_type).toBe('date');
    expect(bookingDate!.confidence).toBe('high');

    // 成績計上月 — month (date と混同しない)
    const bookingMonth = template!.column_decisions.find((d) => d.source_col === '成績計上月');
    expect(bookingMonth!.canonical_field).toBe('performance_booking_month');
    expect(bookingMonth!.inferred_type).toBe('month');
    expect(bookingMonth!.confidence).toBe('high');

    // 請求書発行日 — date
    const invoiceDate = template!.column_decisions.find((d) => d.source_col === '請求書発行日');
    expect(invoiceDate!.canonical_field).toBe('invoice_issued_date');
    expect(invoiceDate!.inferred_type).toBe('date');
    expect(invoiceDate!.confidence).toBe('high');

    // 入金日 — date
    const paymentDate = template!.column_decisions.find((d) => d.source_col === '入金日');
    expect(paymentDate!.canonical_field).toBe('payment_date');
    expect(paymentDate!.inferred_type).toBe('date');
    expect(paymentDate!.confidence).toBe('high');
  });

  it('customer_master template has text / name seed columns', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadTemplateRegistry(outputDir);
    const template = getTemplate(
      '1a94d6a044c75c2cba52cd7fa95d6e6fd66365ff00c96572dc37e8eb4b53706e',
      reg,
    );
    expect(template).not.toBeNull();
    // 70（前回）+ 8（text/name 系）= 78
    expect(template!.column_decisions.length).toBeGreaterThanOrEqual(78);

    // text 系
    const cautionNote = template!.column_decisions.find((d) => d.source_col === '注意事項');
    expect(cautionNote!.canonical_field).toBe('caution_note');
    expect(cautionNote!.inferred_type).toBe('text');
    expect(cautionNote!.confidence).toBe('high');

    const note = template!.column_decisions.find((d) => d.source_col === '備考');
    expect(note!.canonical_field).toBe('note');
    expect(note!.inferred_type).toBe('text');
    expect(note!.confidence).toBe('high');

    const salesComment = template!.column_decisions.find((d) => d.source_col === '営業コメント');
    expect(salesComment!.canonical_field).toBe('sales_comment');
    expect(salesComment!.inferred_type).toBe('text');
    expect(salesComment!.confidence).toBe('high');

    // 工事希望は date ではなく text
    const constructionRequest = template!.column_decisions.find((d) => d.source_col === '工事希望');
    expect(constructionRequest!.canonical_field).toBe('construction_request_note');
    expect(constructionRequest!.inferred_type).toBe('text');
    expect(constructionRequest!.confidence).toBe('high');

    const constructionCondition = template!.column_decisions.find((d) => d.source_col === '工事希望1');
    expect(constructionCondition!.canonical_field).toBe('construction_request_condition');
    expect(constructionCondition!.inferred_type).toBe('text');

    // name 系
    const constructionManager = template!.column_decisions.find((d) => d.source_col === '施工管理');
    expect(constructionManager!.canonical_field).toBe('construction_manager');
    expect(constructionManager!.inferred_type).toBe('name');
    expect(constructionManager!.confidence).toBe('medium'); // 業者略称のため medium

    const salesStore = template!.column_decisions.find((d) => d.source_col === '販売店');
    expect(salesStore!.canonical_field).toBe('sales_store_name');
    expect(salesStore!.inferred_type).toBe('name');
    expect(salesStore!.confidence).toBe('high');

    const installationSite = template!.column_decisions.find((d) => d.source_col === '設置店名');
    expect(installationSite!.canonical_field).toBe('installation_site_name');
    expect(installationSite!.inferred_type).toBe('name');
    expect(installationSite!.confidence).toBe('high');
  });

  it('customer_master template has estimate doc seed columns', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadTemplateRegistry(outputDir);
    const template = getTemplate(
      '1a94d6a044c75c2cba52cd7fa95d6e6fd66365ff00c96572dc37e8eb4b53706e',
      reg,
    );
    expect(template).not.toBeNull();
    // 81（前回）+ 4（見積書系）= 85
    expect(template!.column_decisions.length).toBeGreaterThanOrEqual(85);

    const reqDate = template!.column_decisions.find((d) => d.source_col === '【見積】依頼日');
    expect(reqDate!.canonical_field).toBe('estimate_doc_request_date');
    expect(reqDate!.inferred_type).toBe('date');
    expect(reqDate!.confidence).toBe('high');

    const arrivalDate = template!.column_decisions.find((d) => d.source_col === '【見積】到着日');
    expect(arrivalDate!.canonical_field).toBe('estimate_doc_arrival_date');
    expect(arrivalDate!.inferred_type).toBe('date');
    expect(arrivalDate!.confidence).toBe('high');

    const docNote = template!.column_decisions.find((d) => d.source_col === '【見積】備考');
    expect(docNote!.canonical_field).toBe('estimate_doc_note');
    expect(docNote!.inferred_type).toBe('text');
    expect(docNote!.confidence).toBe('high');

    const manufacturer = template!.column_decisions.find((d) => d.source_col === '【見積】メーカー');
    expect(manufacturer!.canonical_field).toBe('estimate_doc_manufacturer');
    expect(manufacturer!.inferred_type).toBe('name');
    expect(manufacturer!.confidence).toBe('high');
  });

  it('customer_master template has amount seed columns (lease_monthly_amount)', () => {
    const SEED_260312 = join(import.meta.dirname, '../../data/seeds/260312');
    loadSeedDir(SEED_260312, outputDir);

    const reg = loadTemplateRegistry(outputDir);
    const template = getTemplate(
      '1a94d6a044c75c2cba52cd7fa95d6e6fd66365ff00c96572dc37e8eb4b53706e',
      reg,
    );
    expect(template).not.toBeNull();
    // 85（前回）+ 1（リース料金）= 86
    expect(template!.column_decisions.length).toBeGreaterThanOrEqual(86);

    const lease = template!.column_decisions.find((d) => d.source_col === 'リース料金');
    expect(lease!.canonical_field).toBe('lease_monthly_amount');
    expect(lease!.inferred_type).toBe('integer');
    expect(lease!.confidence).toBe('high');
  });
});
