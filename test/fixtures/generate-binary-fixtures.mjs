import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const iconv = require('iconv-lite');
const dir = dirname(fileURLToPath(import.meta.url));

const csvContent = 'name,phone,email\n山田太郎,03-1234-5678,yamada@example.com\n鈴木花子,090-9876-5432,suzuki@example.com\n田中一郎,06-9999-1111,tanaka@example.com\n';

// UTF-8 BOM
writeFileSync(join(dir, 'utf8-bom.csv'), Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(csvContent, 'utf8')]));

// Shift-JIS
writeFileSync(join(dir, 'shiftjis.csv'), iconv.encode(csvContent, 'cp932'));

console.log('Binary fixtures generated.');
