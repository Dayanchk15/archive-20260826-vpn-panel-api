#!/usr/bin/env node
/** Safely deploy only the Cloudflare domain-manager additions to the panel VPS. */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const root = process.cwd();
const host = process.env.PANEL_HOST || 'root@45.140.42.39';
const remoteRoot = process.env.PANEL_ROOT || '/opt/vpn-panel-api-vps';
const work = mkdtempSync(path.join(tmpdir(), 'cf-domain-deploy-'));
const localRoutes = readFileSync(path.join(root, 'routes/admin.js'), 'utf8');
const localHtml = readFileSync(path.join(root, 'public/admin.html'), 'utf8');
const remoteRoutesPath = path.join(work, 'admin.js');
const remoteHtmlPath = path.join(work, 'admin.html');

function run(file, args, options = {}) {
  return execFileSync(file, args, { encoding: 'utf8', stdio: options.stdio || 'pipe' });
}
function scpFrom(remote, local) {
  run('scp', ['-o', 'StrictHostKeyChecking=no', `${host}:${remote}`, local]);
}
function scpTo(local, remote) {
  run('scp', ['-o', 'StrictHostKeyChecking=no', local, `${host}:${remote}`]);
}

const routeMarker = "router.put('/cdn-services/:provider/address-ips'";
const routeStart = localRoutes.indexOf('function normalizeCloudflareDomainCatalog');
const routeEnd = localRoutes.indexOf(routeMarker, routeStart);
if (routeStart < 0 || routeEnd < 0) throw new Error('Cloudflare route block not found in local source');
const routeBlock = localRoutes.slice(routeStart, routeEnd);

const htmlBlockStart = localHtml.indexOf('          <div id="cloudflareDomainManager"');
const htmlBlockEnd = localHtml.indexOf('          <div class="actions" style="margin-top:12px">', htmlBlockStart);
if (htmlBlockStart < 0 || htmlBlockEnd < 0) throw new Error('Cloudflare domain HTML block not found');
const htmlBlock = localHtml.slice(htmlBlockStart, htmlBlockEnd);

const jsBlockStart = localHtml.indexOf('    function renderCloudflareDomains()');
const jsBlockEnd = localHtml.indexOf('    function renderCdnServiceButtons()', jsBlockStart);
if (jsBlockStart < 0 || jsBlockEnd < 0) throw new Error('Cloudflare domain JS block not found');
const jsBlock = localHtml.slice(jsBlockStart, jsBlockEnd);

scpFrom(`${remoteRoot}/routes/admin.js`, remoteRoutesPath);
scpFrom(`${remoteRoot}/public/admin.html`, remoteHtmlPath);
let remoteRoutes = readFileSync(remoteRoutesPath, 'utf8');
let remoteHtml = readFileSync(remoteHtmlPath, 'utf8');

if (!remoteRoutes.includes('function normalizeCloudflareDomainCatalog')) {
  const marker = remoteRoutes.indexOf(routeMarker);
  if (marker < 0) throw new Error('Production CDN route marker not found');
  remoteRoutes = `${remoteRoutes.slice(0, marker)}${routeBlock}${remoteRoutes.slice(marker)}`;
}
if (!remoteHtml.includes('id="cloudflareDomainManager"')) {
  const marker = remoteHtml.indexOf('          <div class="actions" style="margin-top:12px">', remoteHtml.indexOf('id="cdnServiceSharedDomain"'));
  if (marker < 0) throw new Error('Production CDN HTML marker not found');
  remoteHtml = `${remoteHtml.slice(0, marker)}${htmlBlock}${remoteHtml.slice(marker)}`;
}
if (!remoteHtml.includes('let cloudflareDomainsCache = []')) {
  const marker = '    let activeCdnServiceId = null;';
  if (!remoteHtml.includes(marker)) throw new Error('Production CDN JS state marker not found');
  remoteHtml = remoteHtml.replace(marker, `${marker}\n    let cloudflareDomainsCache = [];`);
}
if (!remoteHtml.includes('function renderCloudflareDomains()')) {
  const marker = '    function renderCdnServiceButtons()';
  if (!remoteHtml.includes(marker)) throw new Error('Production CDN JS function marker not found');
  remoteHtml = remoteHtml.replace(marker, `${jsBlock}${marker}`);
}
if (!remoteHtml.includes('renderCloudflareDomains();')) {
  const detailMarker = '        detail.hidden = false;';
  if (!remoteHtml.includes(detailMarker)) throw new Error('Production CDN detail marker not found');
  remoteHtml = remoteHtml.replace(detailMarker, `${detailMarker}\n      renderCloudflareDomains();`);
}
if (!remoteHtml.includes('if (activeCdnServiceId === \'cloudflare\') loadCloudflareDomains();')) {
  const openMarker = "      activeCdnServiceId = String(providerId || '');";
  if (!remoteHtml.includes(openMarker)) throw new Error('Production CDN open marker not found');
  remoteHtml = remoteHtml.replace(openMarker, `${openMarker}\n      if (activeCdnServiceId === 'cloudflare') loadCloudflareDomains();`);
}

writeFileSync(remoteRoutesPath, remoteRoutes);
writeFileSync(remoteHtmlPath, remoteHtml);
run(process.execPath, ['--check', remoteRoutesPath]);

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
run('ssh', ['-o', 'StrictHostKeyChecking=no', host,
  `cp ${remoteRoot}/routes/admin.js ${remoteRoot}/routes/admin.js.bak-cf-domains-${stamp} && cp ${remoteRoot}/public/admin.html ${remoteRoot}/public/admin.html.bak-cf-domains-${stamp}`]);
scpTo(remoteRoutesPath, `${remoteRoot}/routes/admin.js`);
scpTo(remoteHtmlPath, `${remoteRoot}/public/admin.html`);
run('ssh', ['-o', 'StrictHostKeyChecking=no', host,
  'docker restart vpn-panel-api-vps >/dev/null && sleep 3 && docker inspect -f "{{.State.Status}}" vpn-panel-api-vps']);
run('ssh', ['-o', 'StrictHostKeyChecking=no', host,
  'docker exec vpn-panel-api-vps node --check /app/routes/admin.js']);

console.log(JSON.stringify({ ok: true, deployed: ['routes/admin.js', 'public/admin.html'], container: 'vpn-panel-api-vps' }, null, 2));
