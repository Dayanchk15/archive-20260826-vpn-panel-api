#!/usr/bin/env node
import { buildEdgeClientList } from '../lib/edge-clients.js';

const clients = await buildEdgeClientList();
console.log(JSON.stringify(clients));
