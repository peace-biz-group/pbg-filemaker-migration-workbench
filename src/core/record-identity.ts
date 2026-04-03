import { basename } from 'node:path';
import { createHash } from 'node:crypto';
import type { WorkbenchConfig } from '../config/schema.js';
import { globMatch } from './column-mapper.js';
import { semanticStructuralFingerprint } from '../ingest/fingerprint.js';

export type SourceRecordKeyMethod = 'native' | 'deterministic' | 'fallback';
export type MergeEligibility = 'mainline_ready' | 'review' | 'archive_only';
export type SemanticOwner = 'customer_like' | 'deal_like' | 'hybrid' | 'unknown';

export type RecordFamily =
  | 'apo_list'
  | 'customer_master_like'
  | 'deal_like'
  | 'call_activity'
  | 'visit_activity'
  | 'retry_followup'
  | 'unknown';

export interface RecordIdentity {
  sourceRecordKey: string;
  sourceRecordKeyMethod: SourceRecordKeyMethod;
  entityMatchKey: string;
  structuralFingerprint: string;
  structuralFingerprintFull: string;
  structuralFingerprintMainline: string;
  mergeEligibility: MergeEligibility;
  semanticOwner?: SemanticOwner;
  reviewReason?: string;
  recordFamily: RecordFamily;
}

interface IdentityStrategy {
  recordFamily?: RecordFamily;
  nativeIdField?: string;
  deterministicFields?: string[];
  entityMatchFields?: string[];
  fingerprintFields?: string[];
  mainlineFingerprintFields?: string[];
}

const DEFAULT_DETERMINISTIC_FIELDS = ['fm_record_id', 'customer_name', 'company_name', 'activity_date', 'activity_type', 'phone'];
const DEFAULT_ENTITY_FIELDS = ['customer_name', 'company_name', 'store_name', 'phone', 'email'];
const DEFAULT_MAINLINE_FIELDS: Record<RecordFamily, string[]> = {
  apo_list: ['customer_name', 'phone', 'activity_date', 'activity_type', 'note'],
  customer_master_like: ['customer_name', 'company_name', 'phone', 'email', 'address'],
  deal_like: ['customer_name', 'product', 'contract_date', 'amount'],
  call_activity: ['customer_name', 'activity_date', 'activity_type', 'note'],
  visit_activity: ['customer_name', 'activity_date', 'staff', 'note'],
  retry_followup: ['customer_name', 'activity_date', 'product', 'note'],
  unknown: [],
};

function norm(v: string | undefined): string {
  return (v ?? '').trim();
}

function sha(payload: string): string {
  return createHash('sha256').update(payload).digest('hex');
}

function resolveStrategy(sourceFile: string, config: WorkbenchConfig): IdentityStrategy {
  const fileName = basename(sourceFile);
  for (const [pattern, strategy] of Object.entries(config.identityStrategies ?? {})) {
    if (globMatch(pattern, fileName)) return strategy;
  }
  return {};
}

function structuralFingerprint(record: Record<string, string>, fields?: string[]): string {
  return semanticStructuralFingerprint(record, fields);
}

function pickFamily(strategy: IdentityStrategy): RecordFamily {
  return strategy.recordFamily ?? 'unknown';
}

function semanticOwnerOf(record: Record<string, string>, family: RecordFamily): SemanticOwner {
  if (family === 'deal_like' || family === 'retry_followup') return 'deal_like';
  if (family === 'call_activity' || family === 'visit_activity' || family === 'apo_list') return 'customer_like';

  const hasCustomer = Boolean(norm(record.customer_name) || norm(record.company_name) || norm(record.phone) || norm(record.email));
  const hasDeal = Boolean(norm(record.product) || norm(record.contract_date) || norm(record.amount));
  if (hasCustomer && hasDeal) return 'hybrid';
  if (hasCustomer) return 'customer_like';
  if (hasDeal) return 'deal_like';
  return 'unknown';
}

function hasAny(record: Record<string, string>, fields: string[]): boolean {
  return fields.some((f) => norm(record[f]));
}

function isActivityTimestampInsufficient(record: Record<string, string>, family: RecordFamily): boolean {
  if (family === 'call_activity') {
    const hasDate = hasAny(record, ['activity_date']);
    const hasActorOrResult = hasAny(record, ['operator', 'staff', 'result_code']);
    return !hasDate || !hasActorOrResult;
  }
  if (family === 'visit_activity') {
    const hasDate = hasAny(record, ['activity_date']);
    const hasActorOrType = hasAny(record, ['operator', 'staff', 'visit_type', 'result_code']);
    return !hasDate || !hasActorOrType;
  }
  if (family === 'retry_followup') {
    const hasDate = hasAny(record, ['scheduled_followup_date', 'retry_date']);
    const hasActorOrStatus = hasAny(record, ['operator', 'staff', 'retry_status', 'outcome']);
    return !hasDate || !hasActorOrStatus;
  }
  return false;
}

export function buildRecordIdentity(
  record: Record<string, string>,
  opts: { sourceFile: string; mode: 'mainline' | 'archive' },
  config: WorkbenchConfig,
): RecordIdentity {
  const strategy = resolveStrategy(opts.sourceFile, config);
  const family = pickFamily(strategy);

  const nativeField = strategy.nativeIdField;
  const nativeValue = nativeField ? norm(record[nativeField]) : '';

  const deterministicFields = strategy.deterministicFields ?? DEFAULT_DETERMINISTIC_FIELDS;
  const deterministicPairs = deterministicFields
    .map((f) => `${f}=${norm(record[f])}`)
    .filter((x) => !x.endsWith('='));

  const sFingerprint = structuralFingerprint(record, strategy.fingerprintFields);
  const mainlineFields = strategy.mainlineFingerprintFields ?? DEFAULT_MAINLINE_FIELDS[family];
  const sMainlineFingerprint = structuralFingerprint(record, mainlineFields.length > 0 ? mainlineFields : undefined);

  let method: SourceRecordKeyMethod;
  let sourceRecordKey: string;
  if (nativeValue) {
    method = 'native';
    sourceRecordKey = sha(`native\0${family}\0${nativeField}\0${nativeValue}`);
  } else if (deterministicPairs.length > 0) {
    method = 'deterministic';
    sourceRecordKey = sha(`deterministic\0${family}\0${deterministicPairs.join('|')}`);
  } else {
    method = 'fallback';
    sourceRecordKey = sha(`fallback\0${family}\0${sFingerprint}`);
  }

  const entityFields = strategy.entityMatchFields ?? DEFAULT_ENTITY_FIELDS;
  const entityPayload = entityFields
    .map((f) => `${f}=${norm(record[f])}`)
    .filter((x) => !x.endsWith('='))
    .sort()
    .join('|');
  const entityMatchKey = entityPayload ? sha(`entity\0${family}\0${entityPayload}`) : '';

  const semanticOwner = semanticOwnerOf(record, family);

  let mergeEligibility: MergeEligibility = 'mainline_ready';
  let reviewReason = '';
  if (opts.mode === 'archive') {
    mergeEligibility = 'archive_only';
    reviewReason = 'archive_mode';
  } else if (method === 'fallback' && config.mainlineEligibilityRules.disallowFallback) {
    mergeEligibility = 'review';
    reviewReason = 'fallback_key';
  } else if (isActivityTimestampInsufficient(record, family)) {
    mergeEligibility = 'review';
    reviewReason = 'activity_timestamp_insufficient';
  } else if (
    family === 'customer_master_like'
    && config.semanticOwnerRules.enforceCustomerFamilyOwner
    && (
      (semanticOwner === 'unknown' && config.mainlineEligibilityRules.disallowCustomerOwnerUnknown)
      || (semanticOwner === 'hybrid' && config.mainlineEligibilityRules.disallowCustomerOwnerHybrid)
    )
  ) {
    mergeEligibility = 'review';
    reviewReason = semanticOwner === 'hybrid' ? 'semantic_owner_hybrid' : 'semantic_owner_unknown';
  }

  return {
    sourceRecordKey,
    sourceRecordKeyMethod: method,
    entityMatchKey,
    structuralFingerprint: sMainlineFingerprint,
    structuralFingerprintFull: sFingerprint,
    structuralFingerprintMainline: sMainlineFingerprint,
    mergeEligibility,
    semanticOwner,
    reviewReason,
    recordFamily: family,
  };
}
