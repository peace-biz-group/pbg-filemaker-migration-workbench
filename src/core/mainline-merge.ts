import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { createReadStream } from 'node:fs';
import { parse } from 'csv-parse';
import type { WorkbenchConfig } from '../config/schema.js';
import { globMatch } from './column-mapper.js';
import type { MergeLedgerEntry, MergeSummary, SourceMode } from './import-state.js';

interface DiffKeyRule {
  recordIdField?: string;
  updatedAtField?: string;
  naturalKeyFields?: string[];
  fingerprintFields?: string[];
  mode?: SourceMode;
}

export interface MergeInput {
  normalizedPath: string;
  sourceBatchBySourceKey: Record<string, string>;
  modeBySourceKey: Record<string, SourceMode>;
  importRunId: string;
  config: WorkbenchConfig;
  ledger: Record<string, MergeLedgerEntry>;
}

function firstRule(config: WorkbenchConfig, sourceFile: string): [string, DiffKeyRule] | null {
  const fileName = basename(sourceFile);
  for (const [pattern, rule] of Object.entries(config.diffKeys ?? {})) {
    if (globMatch(pattern, fileName)) return [pattern, rule];
  }
  return null;
}

function norm(v: string | undefined): string {
  return (v ?? '').trim();
}

function buildContentFingerprint(row: Record<string, string>, fields?: string[]): string {
  const filtered = Object.entries(row)
    .filter(([k]) => !k.startsWith('_') && (!fields || fields.includes(k)))
    .sort(([a], [b]) => a.localeCompare(b));
  const payload = filtered.map(([k, v]) => `${k}=${v ?? ''}`).join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

function buildDiffIdentity(row: Record<string, string>, rule: DiffKeyRule | null): { identityKey: string; diffKey: string; updatedAt?: string; warning?: string } {
  if (!rule) {
    const fp = buildContentFingerprint(row);
    return { identityKey: `fp:${fp}`, diffKey: `fp:${fp}`, warning: 'diff key rule missing; fallback fingerprint' };
  }

  const ridField = rule.recordIdField;
  const rid = ridField ? norm(row[ridField]) : '';
  if (rid) {
    const updatedAt = rule.updatedAtField ? norm(row[rule.updatedAtField]) : '';
    if (updatedAt) return { identityKey: `rid:${rid}`, diffKey: `rid+updated:${rid}|${updatedAt}`, updatedAt };
    return { identityKey: `rid:${rid}`, diffKey: `rid:${rid}` };
  }

  const naturalFields = rule.naturalKeyFields ?? [];
  if (naturalFields.length > 0) {
    const values = naturalFields.map((f) => norm(row[f]));
    if (values.every((v) => v)) {
      const key = `natural:${naturalFields.map((f, i) => `${f}=${values[i]}`).join('|')}`;
      return { identityKey: key, diffKey: key };
    }
  }

  const fingerprint = buildContentFingerprint(row, rule.fingerprintFields);
  return { identityKey: `fp:${fingerprint}`, diffKey: `fp:${fingerprint}`, warning: 'record id/natural key unavailable; fingerprint fallback' };
}

export async function mergeMainlineRows(input: MergeInput): Promise<MergeSummary> {
  const summary: MergeSummary = { inserted: 0, updated: 0, unchanged: 0, duplicate: 0, skipped_archive: 0, skipped_review: 0, warnings: [] };

  const parser = createReadStream(input.normalizedPath).pipe(parse({ columns: true, skip_empty_lines: true, bom: true }));
  for await (const row of parser) {
    const record = row as Record<string, string>;
    const sourceKey = norm(record._source_key);
    const sourceFile = norm(record._source_file);
    const mode = input.modeBySourceKey[sourceKey] ?? 'archive';

    if (mode !== 'mainline') {
      summary.skipped_archive++;
      continue;
    }

    if (norm(record._merge_eligibility) && norm(record._merge_eligibility) !== 'mainline_ready') {
      summary.skipped_review = (summary.skipped_review ?? 0) + 1;
      summary.warnings.push(`${basename(sourceFile)}: merge eligibility=${record._merge_eligibility} reason=${record._review_reason ?? ''}`);
      continue;
    }

    const matchedRule = firstRule(input.config, sourceFile);
    const identity = buildDiffIdentity(record, matchedRule?.[1] ?? null);
    if (identity.warning) {
      summary.warnings.push(`${basename(sourceFile)}: ${identity.warning}`);
    }

    const rowFingerprint = norm(record._structural_fingerprint_mainline)
      || norm(record._structural_fingerprint)
      || norm(record._row_fingerprint)
      || buildContentFingerprint(record);
    const sourceRecordKey = norm(record._source_record_key);
    const ledgerIdentity = sourceRecordKey || identity.identityKey;
    const ledgerKey = createHash('sha256').update(`${sourceKey}\0${ledgerIdentity}`).digest('hex');
    const existing = input.ledger[ledgerKey];

    if (!existing) {
      input.ledger[ledgerKey] = {
        ledger_key: ledgerKey,
        diff_key: identity.diffKey,
        row_fingerprint: rowFingerprint,
        source_key: sourceKey,
        source_file: sourceFile,
        source_batch_id: input.sourceBatchBySourceKey[sourceKey] ?? '',
        updated_at: identity.updatedAt,
        last_import_run_id: input.importRunId,
        last_seen_at: new Date().toISOString(),
      };
      summary.inserted++;
      continue;
    }

    if (existing.row_fingerprint === rowFingerprint) {
      if (existing.source_batch_id === (input.sourceBatchBySourceKey[sourceKey] ?? '')) {
        summary.duplicate++;
      } else {
        summary.unchanged++;
      }
      existing.last_import_run_id = input.importRunId;
      existing.last_seen_at = new Date().toISOString();
      continue;
    }

    existing.row_fingerprint = rowFingerprint;
    existing.source_file = sourceFile;
    existing.source_batch_id = input.sourceBatchBySourceKey[sourceKey] ?? existing.source_batch_id;
    existing.updated_at = identity.updatedAt;
    existing.last_import_run_id = input.importRunId;
    existing.last_seen_at = new Date().toISOString();
    summary.updated++;
  }

  summary.warnings = Array.from(new Set(summary.warnings));
  return summary;
}
