// src/core/seed-loader.ts
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadRegistry as loadFamilyRegistry,
  registerFingerprint,
  saveRegistry as saveFamilyRegistry,
  type FamilyRegistryEntry,
} from './family-registry.js';
import {
  loadRegistry as loadTemplateRegistry,
  upsertTemplate,
  saveRegistry as saveTemplateRegistry,
  type MappingTemplate,
} from './mapping-template-registry.js';
import {
  loadMemory,
  addResolution,
  saveMemory,
  type ResolutionRecord,
} from './resolution-memory.js';

export interface SeedLoadResult {
  familiesLoaded: number;
  templatesLoaded: number;
  memoriesLoaded: number;
}

/**
 * seedDir 配下の families.json / templates.json / memories.json を
 * outputDir/.decisions/ 以下のレジストリに merge する。
 *
 * 既存エントリは上書きされる（registerFingerprint / upsertTemplate / addResolution の仕様通り）。
 * ファイルが存在しない場合はスキップ（エラーにならない）。
 */
export function loadSeedDir(seedDir: string, outputDir: string): SeedLoadResult {
  let familiesLoaded = 0;
  let templatesLoaded = 0;
  let memoriesLoaded = 0;

  const familiesPath = join(seedDir, 'families.json');
  if (existsSync(familiesPath)) {
    const entries = JSON.parse(readFileSync(familiesPath, 'utf-8')) as FamilyRegistryEntry[];
    let registry = loadFamilyRegistry(outputDir);
    for (const entry of entries) {
      registry = registerFingerprint(entry, registry);
      familiesLoaded++;
    }
    saveFamilyRegistry(registry, outputDir);
  }

  const templatesPath = join(seedDir, 'templates.json');
  if (existsSync(templatesPath)) {
    const templates = JSON.parse(readFileSync(templatesPath, 'utf-8')) as MappingTemplate[];
    let registry = loadTemplateRegistry(outputDir);
    for (const template of templates) {
      registry = upsertTemplate(template, registry);
      templatesLoaded++;
    }
    saveTemplateRegistry(registry, outputDir);
  }

  const memoriesPath = join(seedDir, 'memories.json');
  if (existsSync(memoriesPath)) {
    const records = JSON.parse(readFileSync(memoriesPath, 'utf-8')) as ResolutionRecord[];
    let memory = loadMemory(outputDir);
    for (const record of records) {
      memory = addResolution(record, memory);
      memoriesLoaded++;
    }
    saveMemory(memory, outputDir);
  }

  return { familiesLoaded, templatesLoaded, memoriesLoaded };
}
