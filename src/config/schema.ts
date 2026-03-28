import { z } from 'zod';

/** Column mapping: source column name → canonical field name. */
const columnMappingSchema = z.record(z.string(), z.string());

const normalizationRulesSchema = z.object({
  trimWhitespace: z.boolean().default(true),
  normalizeFullWidthToHalfWidth: z.boolean().default(true),
  normalizePhone: z.boolean().default(true),
  lowercaseEmail: z.boolean().default(true),
  normalizeDates: z.boolean().default(true),
  cleanWhitespaceAndNewlines: z.boolean().default(true),
});

const duplicateDetectionSchema = z.object({
  enablePhoneMatch: z.boolean().default(true),
  enableEmailMatch: z.boolean().default(true),
  enableNameCompanyMatch: z.boolean().default(true),
  enableNameAddressMatch: z.boolean().default(true),
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
});

export const workbenchConfigSchema = z.object({
  /** Display name for this configuration. */
  name: z.string().default('default'),

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
  }),
  duplicateDetection: duplicateDetectionSchema.default({
    enablePhoneMatch: true,
    enableEmailMatch: true,
    enableNameCompanyMatch: true,
    enableNameAddressMatch: true,
  }),
  classification: classificationRulesSchema.default({
    customerFields: ['company_name', 'customer_name', 'phone', 'email', 'address'],
    dealFields: ['deal_name', 'product', 'service', 'contract_date'],
    transactionFields: ['amount', 'payment_date', 'invoice_number'],
    activityFields: ['activity_date', 'activity_type', 'note', 'follow_up'],
    minFieldsForClassification: 2,
  }),

  /** Processing chunk size (records per chunk). */
  chunkSize: z.number().min(100).max(100000).default(5000),

  /** Output directory. */
  outputDir: z.string().default('./output'),
});

export type WorkbenchConfig = z.infer<typeof workbenchConfigSchema>;
export type NormalizationRules = z.infer<typeof normalizationRulesSchema>;
export type ClassificationRules = z.infer<typeof classificationRulesSchema>;
