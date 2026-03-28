/**
 * Duplicate candidate detector.
 * Builds lookup indices in memory for matching keys, processes records in chunks.
 * Does NOT auto-merge — outputs candidate groups only.
 */

import type { RawRecord, DuplicateGroup } from '../types/index.js';
import type { WorkbenchConfig } from '../config/schema.js';
import { readFileInChunks } from '../io/file-reader.js';
import { writeCsv } from '../io/csv-writer.js';
import { companyMatchKey, addressMatchKey, storeMatchKey } from '../normalizers/company.js';
import { join } from 'node:path';
import { ensureOutputDir } from '../io/report-writer.js';

type MatchType = DuplicateGroup['matchType'];

interface IndexEntry {
  row: number;
  sourceFile: string;
  values: Record<string, string>;
}

function resolveField(record: RawRecord, candidates: string[]): string {
  for (const c of candidates) {
    const key = Object.keys(record).find(
      (k) => k.toLowerCase() === c.toLowerCase(),
    );
    if (key && record[key]?.trim()) return record[key].trim();
  }
  return '';
}

export interface DuplicateResult {
  groups: DuplicateGroup[];
  outputPath: string;
}

export async function detectDuplicates(
  filePath: string,
  config: WorkbenchConfig,
): Promise<DuplicateResult> {
  ensureOutputDir(config.outputDir);
  const useNormalizedKeys = config.duplicateDetection.useNormalizedKeys;

  // Indices: key → list of row entries
  const phoneIndex = new Map<string, IndexEntry[]>();
  const emailIndex = new Map<string, IndexEntry[]>();
  const nameCompanyIndex = new Map<string, IndexEntry[]>();
  const nameAddressIndex = new Map<string, IndexEntry[]>();

  let rowCounter = 0;

  await readFileInChunks(filePath, config.chunkSize, async (chunk, _idx) => {
    for (const record of chunk) {
      rowCounter++;
      const sourceFile = record['_source_file'] ?? '';
      const entry: IndexEntry = { row: rowCounter, sourceFile, values: {} };

      const phone = resolveField(record, config.canonicalFields.phone);
      const email = resolveField(record, config.canonicalFields.email);
      const name = resolveField(record, config.canonicalFields.name);
      const company = resolveField(record, config.canonicalFields.companyName);
      const store = resolveField(record, config.canonicalFields.storeName);
      const address = resolveField(record, config.canonicalFields.address);

      entry.values = { phone, email, name, company, store, address, _source_file: sourceFile };

      // Phone index
      if (config.duplicateDetection.enablePhoneMatch && phone) {
        const key = phone;
        if (!phoneIndex.has(key)) phoneIndex.set(key, []);
        phoneIndex.get(key)!.push(entry);
      }

      // Email index
      if (config.duplicateDetection.enableEmailMatch && email) {
        const key = email.toLowerCase();
        if (!emailIndex.has(key)) emailIndex.set(key, []);
        emailIndex.get(key)!.push(entry);
      }

      // Name + Company/Store index
      if (config.duplicateDetection.enableNameCompanyMatch && name) {
        const org = company || store;
        if (org) {
          const orgKey = useNormalizedKeys
            ? (company ? companyMatchKey(company) : storeMatchKey(store))
            : (company || store).toLowerCase();
          const key = `${name.toLowerCase()}|${orgKey}`;
          if (!nameCompanyIndex.has(key)) nameCompanyIndex.set(key, []);
          nameCompanyIndex.get(key)!.push(entry);
        }
      }

      // Name + Address index
      if (config.duplicateDetection.enableNameAddressMatch && name && address) {
        const addrKey = useNormalizedKeys ? addressMatchKey(address) : address.toLowerCase();
        const key = `${name.toLowerCase()}|${addrKey}`;
        if (!nameAddressIndex.has(key)) nameAddressIndex.set(key, []);
        nameAddressIndex.get(key)!.push(entry);
      }
    }
  });

  // Build groups from indices (only where count >= 2)
  const groups: DuplicateGroup[] = [];
  let groupId = 0;

  function addGroups(index: Map<string, IndexEntry[]>, matchType: MatchType) {
    for (const [key, entries] of index) {
      if (entries.length >= 2) {
        groups.push({
          groupId: ++groupId,
          matchKey: key,
          matchType,
          records: entries.map((e) => ({ row: e.row, values: e.values })),
        });
      }
    }
  }

  addGroups(phoneIndex, 'phone');
  addGroups(emailIndex, 'email');
  addGroups(nameCompanyIndex, 'name_company');
  addGroups(nameAddressIndex, 'name_address');

  // Write to CSV
  const outputPath = join(config.outputDir, 'duplicates.csv');
  const flatRecords: RawRecord[] = [];
  for (const group of groups) {
    for (const rec of group.records) {
      flatRecords.push({
        group_id: String(group.groupId),
        match_type: group.matchType,
        match_key: group.matchKey,
        row: String(rec.row),
        ...rec.values,
      });
    }
  }
  await writeCsv(outputPath, flatRecords);

  return { groups, outputPath };
}
