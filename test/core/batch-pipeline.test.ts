import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { normalizeFiles } from '../../src/core/normalizer.js';
import { detectDuplicates } from '../../src/core/duplicate-detector.js';
import { classifyFile } from '../../src/core/classifier.js';
import { loadConfig } from '../../src/config/defaults.js';
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURES = join(import.meta.dirname, '..', 'fixtures');
const APO_LIST = join(FIXTURES, 'apo_list_2024.csv');
const PRODUCT_CUSTOMERS = join(FIXTURES, 'product_a_customers.csv');
const CONFIG_PATH = join(FIXTURES, 'test-batch.config.json');
const OUTPUT = join(import.meta.dirname, '..', 'output-batch-test');

describe('Batch pipeline (multi-file)', () => {
  let config: ReturnType<typeof loadConfig>;

  beforeAll(() => {
    config = loadConfig(CONFIG_PATH);
    config.outputDir = OUTPUT;
    mkdirSync(OUTPUT, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) {
      rmSync(OUTPUT, { recursive: true, force: true });
    }
  });

  it('normalizes multiple files with column mapping into merged output', async () => {
    const result = await normalizeFiles(
      [
        { path: APO_LIST, label: 'アポリスト2024' },
        { path: PRODUCT_CUSTOMERS, label: '商材A顧客管理' },
      ],
      config,
    );

    // アポリスト: 6 rows (1 empty → quarantine), 商材A顧客管理: 6 rows
    expect(result.normalizedCount + result.quarantineCount).toBe(12);
    expect(result.quarantineCount).toBeGreaterThanOrEqual(1);

    // Check normalized.csv exists and has _source_file column
    const content = readFileSync(result.normalizedPath, 'utf-8');
    expect(content).toContain('_source_file');
    expect(content).toContain('アポリスト2024');
    expect(content).toContain('商材A顧客管理');

    // Check column mapping was applied — should have canonical names like 'customer_name'
    const headerLine = content.split('\n')[0];
    expect(headerLine).toContain('customer_name');
    expect(headerLine).toContain('phone');
    expect(headerLine).toContain('email');
    // Original Japanese column names should NOT appear (they were mapped)
    expect(headerLine).not.toContain('顧客名');
    expect(headerLine).not.toContain('電話番号');
  });

  it('detects cross-file duplicates', async () => {
    const normResult = await normalizeFiles(
      [
        { path: APO_LIST, label: 'アポリスト2024' },
        { path: PRODUCT_CUSTOMERS, label: '商材A顧客管理' },
      ],
      config,
    );

    const dupResult = await detectDuplicates(normResult.normalizedPath, config);

    // 田中太郎 (phone 0312345678) appears in both files
    // 鈴木花子 (phone 09098765432) appears in both files
    // 高橋美咲 (phone 08011112222) appears in both files
    // 佐藤一郎 (email sato@example.org) appears in both files
    expect(dupResult.groups.length).toBeGreaterThan(0);

    // Verify cross-file groups exist
    const crossFileGroups = dupResult.groups.filter((g) => {
      const sources = new Set(g.records.map((r) => r.values['_source_file']));
      return sources.size > 1;
    });
    expect(crossFileGroups.length).toBeGreaterThan(0);

    // Check phone match for 田中太郎
    const phoneGroups = dupResult.groups.filter((g) => g.matchType === 'phone');
    const tanakaGroup = phoneGroups.find((g) => g.matchKey === '0312345678');
    expect(tanakaGroup).toBeDefined();
    expect(tanakaGroup!.records.length).toBeGreaterThanOrEqual(2);
  });

  it('classifies merged records with priority order', async () => {
    const normResult = await normalizeFiles(
      [
        { path: APO_LIST, label: 'アポリスト2024' },
        { path: PRODUCT_CUSTOMERS, label: '商材A顧客管理' },
      ],
      config,
    );

    const classResult = await classifyFile(normResult.normalizedPath, config);
    const total = Object.values(classResult.breakdown).reduce((a, b) => a + b, 0);
    expect(total).toBe(normResult.normalizedCount);

    // customer should be the dominant type for these records
    expect(classResult.breakdown.customer).toBeGreaterThan(0);
    // transaction should be deprioritized (customer/deal wins when fields overlap)
    expect(classResult.breakdown.customer).toBeGreaterThanOrEqual(classResult.breakdown.transaction);

    expect(existsSync(classResult.outputPath)).toBe(true);
  });

  it('company name variants match as duplicates', async () => {
    const normResult = await normalizeFiles(
      [
        { path: APO_LIST, label: 'アポリスト2024' },
        { path: PRODUCT_CUSTOMERS, label: '商材A顧客管理' },
      ],
      config,
    );

    const dupResult = await detectDuplicates(normResult.normalizedPath, config);

    // 株式会社テスト, （株）テスト, (株)テスト should all match via companyMatchKey
    const nameCompanyGroups = dupResult.groups.filter((g) => g.matchType === 'name_company');
    // 田中太郎 + テスト(various forms) should form a group
    const tanakaCompanyGroup = nameCompanyGroups.find((g) =>
      g.records.some((r) => r.values.name?.includes('田中')),
    );
    expect(tanakaCompanyGroup).toBeDefined();
  });
});
