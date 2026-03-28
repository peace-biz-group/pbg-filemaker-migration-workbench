import { workbenchConfigSchema, type WorkbenchConfig } from './schema.js';
import { readFileSync, existsSync } from 'node:fs';

export function loadConfig(configPath?: string): WorkbenchConfig {
  if (configPath && existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    return workbenchConfigSchema.parse(raw);
  }
  return workbenchConfigSchema.parse({});
}
