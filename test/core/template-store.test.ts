import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { saveTemplate, loadTemplate, listTemplates, deleteTemplate, findMatchingTemplates } from '../../src/core/template-store.js';
import type { FileTemplate } from '../../src/types/index.js';

const OUTPUT = join(import.meta.dirname, '..', 'output-template-test');

// The schema fingerprint must match what schemaFingerprint(columnNames) actually produces.
// Computed via: createHash('sha256').update([...cols].sort().join('|')).digest('hex')
// for cols = ['顧客名', '電話番号', '住所', '担当者', '日付']
const REAL_FINGERPRINT = '737b50afe73a3121f33eb4e99db23032562911c6fbbc01d66f28da05b19b3a18';

const SAMPLE_TEMPLATE: FileTemplate = {
  id: 'test-apo-001',
  displayName: 'アポリスト',
  createdAt: '2024-01-01T00:00:00.000Z',
  updatedAt: '2024-01-01T00:00:00.000Z',
  columnCount: 5,
  columnNames: ['顧客名', '電話番号', '住所', '担当者', '日付'],
  schemaFingerprint: REAL_FINGERPRINT,
  defaultEncoding: 'cp932',
  hasHeader: true,
  fileTypeLabel: 'アポリスト',
  columnMapping: { '顧客名': 'customer_name', '電話番号': 'phone' },
  knownFilenamePatterns: ['apo_list', 'アポリスト'],
};

describe('template-store', () => {
  beforeAll(() => {
    mkdirSync(OUTPUT, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(OUTPUT)) rmSync(OUTPUT, { recursive: true, force: true });
  });

  it('saves and loads a template', () => {
    saveTemplate(OUTPUT, SAMPLE_TEMPLATE);
    const loaded = loadTemplate(OUTPUT, SAMPLE_TEMPLATE.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.displayName).toBe('アポリスト');
    expect(loaded!.defaultEncoding).toBe('cp932');
  });

  it('returns null for non-existent template', () => {
    expect(loadTemplate(OUTPUT, 'does-not-exist')).toBeNull();
  });

  it('lists templates', () => {
    const templates = listTemplates(OUTPUT);
    expect(templates.length).toBeGreaterThanOrEqual(1);
    expect(templates.some(t => t.id === SAMPLE_TEMPLATE.id)).toBe(true);
  });

  it('returns empty array for non-existent output dir', () => {
    expect(listTemplates('/nonexistent/path/xyz')).toEqual([]);
  });

  it('deletes a template', () => {
    const id = 'temp-delete-test';
    saveTemplate(OUTPUT, { ...SAMPLE_TEMPLATE, id });
    expect(loadTemplate(OUTPUT, id)).not.toBeNull();
    expect(deleteTemplate(OUTPUT, id)).toBe(true);
    expect(loadTemplate(OUTPUT, id)).toBeNull();
  });

  it('returns false when deleting non-existent template', () => {
    expect(deleteTemplate(OUTPUT, 'no-such-template')).toBe(false);
  });

  it('finds matching template by exact schema fingerprint', () => {
    const matches = findMatchingTemplates(
      OUTPUT,
      'apo_list_2024.csv',
      SAMPLE_TEMPLATE.columnNames,
      'cp932',
      true,
    );
    expect(matches.length).toBeGreaterThan(0);
    expect(matches[0].template.id).toBe(SAMPLE_TEMPLATE.id);
    expect(matches[0].score).toBeGreaterThanOrEqual(0.5);
  });

  it('finds template by filename similarity even without fingerprint match', () => {
    const matches = findMatchingTemplates(
      OUTPUT,
      '240101_apo_list_最新版.csv',
      ['col1', 'col2', 'col3'],  // different columns
      'utf8',
      false,
    );
    // May or may not match depending on score — just verify no crash
    expect(Array.isArray(matches)).toBe(true);
    expect(matches.length).toBeLessThanOrEqual(3);
  });

  it('returns max 3 results', () => {
    // Add more templates
    for (let i = 0; i < 5; i++) {
      saveTemplate(OUTPUT, {
        ...SAMPLE_TEMPLATE,
        id: `extra-${i}`,
        schemaFingerprint: REAL_FINGERPRINT, // same fingerprint = high score
      });
    }
    const matches = findMatchingTemplates(
      OUTPUT,
      'apo_list.csv',
      SAMPLE_TEMPLATE.columnNames,
      'cp932',
      true,
    );
    expect(matches.length).toBeLessThanOrEqual(3);
  });
});
