#!/usr/bin/env node
import { getServerById } from '../lib/db-store.js';
const id = process.argv[2] || 'server-23';
console.log(JSON.stringify(await getServerById(id), null, 2));
