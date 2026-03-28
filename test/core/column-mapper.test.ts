import { describe, it, expect } from 'vitest';
import { findColumnMapping, applyColumnMapping, mapColumnNames } from '../../src/core/column-mapper.js';
import { loadConfig } from '../../src/config/defaults.js';
import { join } from 'node:path';

const CONFIG_PATH = join(import.meta.dirname, '..', 'fixtures', 'test-batch.config.json');

describe('findColumnMapping', () => {
  it('matches apo_list_*.csv pattern', () => {
    const config = loadConfig(CONFIG_PATH);
    const mapping = findColumnMapping('/data/apo_list_2024.csv', config);
    expect(mapping).not.toBeNull();
    expect(mapping!['顧客名']).toBe('customer_name');
    expect(mapping!['電話番号']).toBe('phone');
  });

  it('matches product_*_customers.csv pattern', () => {
    const config = loadConfig(CONFIG_PATH);
    const mapping = findColumnMapping('/data/product_a_customers.csv', config);
    expect(mapping).not.toBeNull();
    expect(mapping!['氏名']).toBe('customer_name');
    expect(mapping!['TEL']).toBe('phone');
    expect(mapping!['法人名']).toBe('company_name');
  });

  it('returns null for unmatched file', () => {
    const config = loadConfig(CONFIG_PATH);
    const mapping = findColumnMapping('/data/random_file.csv', config);
    expect(mapping).toBeNull();
  });
});

describe('applyColumnMapping', () => {
  it('renames columns', () => {
    const mapping = { '顧客名': 'customer_name', '電話番号': 'phone' };
    const record = { '顧客名': '田中太郎', '電話番号': '03-1234-5678', '住所': '東京都' };
    const result = applyColumnMapping(record, mapping);
    expect(result).toEqual({
      customer_name: '田中太郎',
      phone: '03-1234-5678',
      '住所': '東京都',
    });
  });

  it('keeps unmapped columns', () => {
    const mapping = { 'a': 'x' };
    const record = { a: '1', b: '2' };
    const result = applyColumnMapping(record, mapping);
    expect(result).toEqual({ x: '1', b: '2' });
  });
});

describe('mapColumnNames', () => {
  it('renames matched columns, keeps others', () => {
    const cols = ['顧客名', '電話番号', '住所'];
    const mapping = { '顧客名': 'customer_name', '電話番号': 'phone' };
    expect(mapColumnNames(cols, mapping)).toEqual(['customer_name', 'phone', '住所']);
  });
});
