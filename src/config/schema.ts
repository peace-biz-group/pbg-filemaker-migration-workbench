import { z } from 'zod';

/** Column mapping: source column name → canonical field name. */
const columnMappingSchema = z.record(z.string(), z.string());

const ingestOptionsSchema = z.object({
  encoding: z.enum(['auto', 'utf8', 'cp932']).default('auto'),
  delimiter: z.enum(['auto', ',', '\t', ';']).default('auto'),
  hasHeader: z.boolean().default(true),
  skipRows: z.number().int().min(0).default(0),
  previewRows: z.number().int().min(1).optional(),
});
export type IngestOptionsConfig = z.infer<typeof ingestOptionsSchema>;

const normalizationRulesSchema = z.object({
  trimWhitespace: z.boolean().default(true),
  normalizeFullWidthToHalfWidth: z.boolean().default(true),
  normalizePhone: z.boolean().default(true),
  lowercaseEmail: z.boolean().default(true),
  normalizeDates: z.boolean().default(true),
  cleanWhitespaceAndNewlines: z.boolean().default(true),
  normalizeCompanyName: z.boolean().default(true),
  normalizeAddress: z.boolean().default(true),
  normalizeStoreName: z.boolean().default(true),
});

const duplicateDetectionSchema = z.object({
  enablePhoneMatch: z.boolean().default(true),
  enableEmailMatch: z.boolean().default(true),
  enableNameCompanyMatch: z.boolean().default(true),
  enableNameAddressMatch: z.boolean().default(true),
  /** Use normalized keys for company/address matching (absorbs variants). */
  useNormalizedKeys: z.boolean().default(true),
});

const classificationRulesSchema = z.object({
  customerFields: z.array(z.string()).default([
    'company_name', 'customer_name', 'phone', 'email', 'address',
  ]),
  dealFields: z.array(z.string()).default([
    'deal_name', 'product', 'service', 'contract_date',
  ]),
  transactionFields: z.array(z.string()).default([
    'amount', 'payment_date', 'invoice_number',
  ]),
  activityFields: z.array(z.string()).default([
    'activity_date', 'activity_type', 'note', 'follow_up',
  ]),
  /** Minimum number of non-empty canonical fields to avoid quarantine. */
  minFieldsForClassification: z.number().default(2),
  /**
   * Priority order for classification when scores tie.
   * Types listed first win over types listed later.
   * 'transaction' is deprioritized by default — in FileMaker data,
   * amount/invoice fields often co-exist with customer or deal fields,
   * and treating them as standalone transaction records is premature.
   */
  priorityOrder: z.array(z.string()).default([
    'customer', 'deal', 'activity', 'transaction',
  ]),
});

/** Input file entry for multi-file runs. */
const inputFileSchema = z.object({
  path: z.string(),
  /** Optional: override which column mapping pattern to use. */
  mappingPattern: z.string().optional(),
  /** Optional: label for this source in reports. */
  label: z.string().optional(),
  /** Optional: logical source key for this file. */
  sourceKey: z.string().optional(),
  /** Optional: per-file ingest options. */
  ingestOptions: ingestOptionsSchema.partial().optional(),
  /** Optional: source mode for merge stage. Defaults to archive. */
  mode: z.enum(['mainline', 'archive']).optional(),
});



const diffKeyRuleSchema = z.object({
  recordIdField: z.string().optional(),
  updatedAtField: z.string().optional(),
  naturalKeyFields: z.array(z.string()).optional(),
  fingerprintFields: z.array(z.string()).optional(),
  mode: z.enum(['mainline', 'archive']).optional(),
});

const identityStrategySchema = z.object({
  recordFamily: z.enum(['apo_list', 'customer_master_like', 'deal_like', 'call_activity', 'visit_activity', 'retry_followup']).optional(),
  nativeIdField: z.string().optional(),
  deterministicFields: z.array(z.string()).optional(),
  entityMatchFields: z.array(z.string()).optional(),
  fingerprintFields: z.array(z.string()).optional(),
  mainlineFingerprintFields: z.array(z.string()).optional(),
});
export const workbenchConfigSchema = z.object({
  /** Display name for this configuration. */
  name: z.string().default('default'),

  /** Input files for batch/multi-file runs. */
  inputs: z.array(inputFileSchema).default([]),

  /** Column mappings per source file pattern. */
  columnMappings: z.record(z.string(), columnMappingSchema).default({}),

  /** Canonical field names for key matching columns. */
  canonicalFields: z.object({
    phone: z.array(z.string()).default(['phone', 'tel', '電話番号']),
    email: z.array(z.string()).default(['email', 'mail', 'メールアドレス']),
    name: z.array(z.string()).default(['name', '氏名', '名前', '担当者名']),
    companyName: z.array(z.string()).default(['company', 'company_name', '会社名', '法人名']),
    storeName: z.array(z.string()).default(['store', 'store_name', '店舗名']),
    address: z.array(z.string()).default(['address', '住所', '所在地']),
  }).default({
    phone: ['phone', 'tel', '電話番号'],
    email: ['email', 'mail', 'メールアドレス'],
    name: ['name', '氏名', '名前', '担当者名'],
    companyName: ['company', 'company_name', '会社名', '法人名'],
    storeName: ['store', 'store_name', '店舗名'],
    address: ['address', '住所', '所在地'],
  }),

  normalization: normalizationRulesSchema.default({
    trimWhitespace: true,
    normalizeFullWidthToHalfWidth: true,
    normalizePhone: true,
    lowercaseEmail: true,
    normalizeDates: true,
    cleanWhitespaceAndNewlines: true,
    normalizeCompanyName: true,
    normalizeAddress: true,
    normalizeStoreName: true,
  }),
  duplicateDetection: duplicateDetectionSchema.default({
    enablePhoneMatch: true,
    enableEmailMatch: true,
    enableNameCompanyMatch: true,
    enableNameAddressMatch: true,
    useNormalizedKeys: true,
  }),
  classification: classificationRulesSchema.default({
    customerFields: ['company_name', 'customer_name', 'phone', 'email', 'address'],
    dealFields: ['deal_name', 'product', 'service', 'contract_date'],
    transactionFields: ['amount', 'payment_date', 'invoice_number'],
    activityFields: ['activity_date', 'activity_type', 'note', 'follow_up'],
    minFieldsForClassification: 2,
    priorityOrder: ['customer', 'deal', 'activity', 'transaction'],
  }),

  /** Diff-key strategy per file pattern for idempotent mainline merge. */
  diffKeys: z.record(z.string(), diffKeyRuleSchema).default({}),

  /** Semantic identity strategy per file pattern. */
  identityStrategies: z.record(z.string(), identityStrategySchema).default({}),

  /** Semantic owner rules (minimal v1 placeholder for future extension). */
  semanticOwnerRules: z.object({
    enforceCustomerFamilyOwner: z.boolean().default(true),
  }).default({
    enforceCustomerFamilyOwner: true,
  }),

  /** Mainline merge eligibility rules. */
  mainlineEligibilityRules: z.object({
    disallowFallback: z.boolean().default(true),
    disallowCustomerOwnerUnknown: z.boolean().default(true),
    disallowCustomerOwnerHybrid: z.boolean().default(true),
  }).default({
    disallowFallback: true,
    disallowCustomerOwnerUnknown: true,
    disallowCustomerOwnerHybrid: true,
  }),

  /** Processing chunk size (records per chunk). */
  chunkSize: z.number().min(100).max(100000).default(5000),

  /** Output directory. */
  outputDir: z.string().default('./output'),

  /** Global ingest options (can be overridden per file). */
  ingestOptions: ingestOptionsSchema.partial().optional(),

  /** Index-based column mappings: filename pattern → column mapping. */
  indexMappings: z.record(z.string(), z.record(z.string(), z.string())).default({}),

  /** Schema fingerprint-based column mappings: schemaFP → column mapping. */
  schemaMappings: z.record(z.string(), columnMappingSchema).default({}),
});

export type WorkbenchConfig = z.infer<typeof workbenchConfigSchema>;
export type NormalizationRules = z.infer<typeof normalizationRulesSchema>;
export type ClassificationRules = z.infer<typeof classificationRulesSchema>;
export type InputFile = z.infer<typeof inputFileSchema>;
