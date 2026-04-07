/**
 * Seeds mapping templates from 260312 staging-column-map.csv
 * into {outputDir}/.decisions/mapping-template-registry.json
 *
 * Usage: npx tsx scripts/seed-mapping-templates-260312.ts [outputDir]
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createEmptyRegistry,
  upsertTemplate,
  loadRegistry,
  saveRegistry,
  computeAutoApplyEligibility,
  type ColumnDecision,
  type MappingTemplate,
} from '../src/core/mapping-template-registry.js';
import { computeSchemaFingerprint } from '../src/core/review-bundle.js';

const COLUMN_MAP_CSV = join(
  import.meta.dirname,
  '../artifacts/filemaker-audit/solar/260312/staging-column-map.csv',
);
const outputDir = process.argv[2] ?? './output';

const SOURCE_FILE_TO_FAMILY: Record<string, string> = {
  '260312_顧客_太陽光.csv': 'customer_master',
  '260312_コール履歴_太陽光.xlsx': 'call_history',
};

function parseCsvLine(line: string): string[] {
  const result: string[] = [];
  let cur = '';
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === ',' && !inQuotes) {
      result.push(cur);
      cur = '';
    } else {
      cur += ch;
    }
  }
  result.push(cur);
  return result;
}

function main() {
  const lines = readFileSync(COLUMN_MAP_CSV, 'utf-8').split('\n').filter(Boolean);
  const headers = parseCsvLine(lines[0]);
  const iSourceFile = headers.indexOf('source_file');
  const iSourceColumn = headers.indexOf('source_column');
  const iProposedCanonical = headers.indexOf('proposed_canonical');
  const rows = lines.slice(1).map((line) => parseCsvLine(line));

  // Group rows by source_file
  const bySourceFile = new Map<string, string[][]>();
  for (const row of rows) {
    const sourceFile = row[iSourceFile] ?? '';
    if (!sourceFile) continue;
    if (!bySourceFile.has(sourceFile)) bySourceFile.set(sourceFile, []);
    bySourceFile.get(sourceFile)!.push(row);
  }

  let registry = loadRegistry(outputDir);
  let seededCount = 0;
  const now = new Date().toISOString();

  for (const [sourceFile, fileRows] of bySourceFile.entries()) {
    const familyId = SOURCE_FILE_TO_FAMILY[sourceFile] ?? 'unknown';
    const templateId = `${familyId}_v1`;

    const columnDecisions: ColumnDecision[] = fileRows.map((row) => {
      const sourceCol = row[iSourceColumn] ?? '';
      const proposedCanonical = row[iProposedCanonical] ?? '';
      return {
        source_col: sourceCol,
        canonical_field: proposedCanonical !== '' ? proposedCanonical : null,
        inferred_type: 'text',
        normalization_rule: null,
        confidence: 'confirmed' as const,
        decided_at: now,
        decided_by: 'human' as const,
      };
    });

    const columnNames = columnDecisions.map((d) => d.source_col);
    const schemaFingerprint = computeSchemaFingerprint(columnNames);
    const eligibility = computeAutoApplyEligibility(columnDecisions);

    const template: MappingTemplate = {
      template_id: templateId,
      family_id: familyId,
      schema_fingerprint: schemaFingerprint,
      version: 1,
      created_at: now,
      confirmed_at: now,
      column_decisions: columnDecisions,
      auto_apply_eligibility: eligibility,
      known_schema_fingerprints: [schemaFingerprint],
    };

    registry = upsertTemplate(template, registry);
    console.log(
      `  ${familyId}: ${columnDecisions.length} columns → template_id=${templateId}, eligibility=${eligibility}`,
    );
    seededCount++;
  }

  saveRegistry(registry, outputDir);
  console.log(`\nSeeded ${seededCount} templates → ${outputDir}/.decisions/mapping-template-registry.json`);
}

main();
