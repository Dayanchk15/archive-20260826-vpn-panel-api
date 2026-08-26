#!/usr/bin/env node

/**
 * Read-only repository hygiene audit.
 *
 * This script never deletes or modifies files and never connects to servers.
 * It prints candidates that should be reviewed before being quarantined.
 */
import { auditRepositoryJunk } from '../lib/repository-maintenance-audit.js';

const report = await auditRepositoryJunk({ maxItems: 500 });
console.log(JSON.stringify({
  ...report,
  message: 'No files were modified or deleted.',
}, null, 2));
