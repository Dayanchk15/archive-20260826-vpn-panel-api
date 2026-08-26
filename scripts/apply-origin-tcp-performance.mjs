#!/usr/bin/env node
/**
 * Apply BBR/fq/buffers + conntrack + nofile without restarting Xray.
 * - CDN origins: FR2 / Tampa / Fornex (FR1 skipped)
 * - Relay docker edges: NL / DE / AM / GB / DE2
 * Does NOT touch panel host Remnawave :443.
 *
 * Usage:
 *   node scripts/apply-origin-tcp-performance.mjs audit
 *   node scripts/apply-origin-tcp-performance.mjs apply
 *   node scripts/apply-origin-tcp-performance.mjs apply --cdn-only
 *   node scripts/apply-origin-tcp-performance.mjs apply --relays-only
 */
import { spawn } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const KEY = process.env.SSH_KEY || 'C:\\Users\\Admin\\.ssh\\id_ed25519';
const JUMP = process.env.JUMP_HOST || 'root@194.127.179.178';
const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = join(ROOT, '..', 'config');

const CDN_ORIGINS = [
  { id: 'fr2', host: '185.209.230.46', jump: false, group: 'cdn' },
  { id: 'tampa', host: '74.115.172.101', jump: false, group: 'cdn' },
  { id: 'fornex', host: '130.17.12.61', jump: false, group: 'cdn' },
];

const RELAY_EDGES = [
  { id: 'nl', host: '194.127.178.70', jump: true, group: 'relay' },
  { id: 'de', host: '2.26.231.130', jump: true, group: 'relay' },
  { id: 'am', host: '194.127.179.178', jump: false, group: 'relay' },
  { id: 'gb', host: '185.169.234.182', jump: true, group: 'relay' },
  { id: 'de2', host: '45.133.251.146', jump: false, group: 'relay' },
];

const SCALE_CONF_PATH = existsSync(join(CONFIG_DIR, '99-vpn-scale-performance.conf'))
  ? join(CONFIG_DIR, '99-vpn-scale-performance.conf')
  : join(CONFIG_DIR, '99-vpn-bunny-performance.conf');
const PERF_CONF = readFileSync(SCALE_CONF_PATH, 'utf8');
const MODULE_CONF = readFileSync(join(CONFIG_DIR, 'tcp_bbr.conf'), 'utf8');
const NOFILE_CONF = readFileSync(join(CONFIG_DIR, '99-vpn-nofile.conf'), 'utf8');

const AUDIT_SH = [
  '#!/bin/bash',
  'set -euo pipefail',
  'echo "===HOST $(hostname -f 2>/dev/null || hostname)==="',
  'echo "cc=$(sysctl -n net.ipv4.tcp_congestion_control 2>/dev/null || echo none)"',
  'echo "qdisc=$(sysctl -n net.core.default_qdisc 2>/dev/null || echo none)"',
  'echo "mtu=$(sysctl -n net.ipv4.tcp_mtu_probing 2>/dev/null || echo none)"',
  'echo "rmem_max=$(sysctl -n net.core.rmem_max 2>/dev/null || echo none)"',
  'echo "wmem_max=$(sysctl -n net.core.wmem_max 2>/dev/null || echo none)"',
  'echo "somaxconn=$(sysctl -n net.core.somaxconn 2>/dev/null || echo none)"',
  'echo "file_max=$(sysctl -n fs.file-max 2>/dev/null || echo none)"',
  'echo "nf_conntrack_max=$(sysctl -n net.netfilter.nf_conntrack_max 2>/dev/null || echo none)"',
  'echo "nf_conntrack_count=$(sysctl -n net.netfilter.nf_conntrack_count 2>/dev/null || echo none)"',
  'echo "persist_sysctl=$([ -f /etc/sysctl.d/99-vpn-scale-performance.conf ] || [ -f /etc/sysctl.d/99-vpn-bunny-performance.conf ] && echo yes || echo no)"',
  'echo "persist_mod=$([ -f /etc/modules-load.d/tcp_bbr.conf ] && echo yes || echo no)"',
  'echo "persist_nofile=$([ -f /etc/security/limits.d/99-vpn-nofile.conf ] && echo yes || echo no)"',
  'echo "bbr_mod=$(lsmod | awk \'/^tcp_bbr /{print $1}\' || true)"',
  'echo "---nofile-sample---"',
  'for p in $(pgrep -x xray | head -3) $(pgrep -x dockerd | head -1); do',
  '  [ -n "$p" ] || continue',
  '  soft=$(awk \'/Max open files/{print $4"/"$5; exit}\' /proc/$p/limits 2>/dev/null || echo n/a)',
  '  echo "pid=$p nofile=$soft"',
  'done',
  'echo "===END==="',
  '',
].join('\n');

function buildApplySh() {
  return [
    '#!/bin/bash',
    'set -euo pipefail',
    'PERF=/tmp/99-vpn-scale-performance.conf',
    'MOD=/tmp/tcp_bbr.conf',
    'NOFILE=/tmp/99-vpn-nofile.conf',
    'TARGET_PERF=/etc/sysctl.d/99-vpn-scale-performance.conf',
    'TARGET_MOD=/etc/modules-load.d/tcp_bbr.conf',
    'TARGET_NOFILE=/etc/security/limits.d/99-vpn-nofile.conf',
    'TARGET_SYSTEMD=/etc/systemd/system.conf.d/99-vpn-nofile.conf',
    '[ -r "$PERF" ] || { echo missing_perf; exit 1; }',
    '[ -r "$MOD" ] || { echo missing_mod; exit 1; }',
    '[ -r "$NOFILE" ] || { echo missing_nofile; exit 1; }',
    'modinfo tcp_bbr >/dev/null',
    'modprobe nf_conntrack 2>/dev/null || true',
    'declare -A BEFORE=()',
    'while read -r u; do',
    '  [ -n "$u" ] || continue',
    '  BEFORE["$u"]="$(systemctl show -p MainPID --value "$u")"',
    "done < <(systemctl list-units --type=service --state=running --no-legend 'xray*' 2>/dev/null | awk '{print $1}')",
    'stamp="$(date -u +%Y%m%dT%H%M%SZ)"',
    'for f in "$TARGET_PERF" /etc/sysctl.d/99-vpn-bunny-performance.conf "$TARGET_MOD" "$TARGET_NOFILE" "$TARGET_SYSTEMD"; do',
    '  [ -e "$f" ] && cp -a "$f" "$f.pre-scale-tuning.$stamp" || true',
    'done',
    'modprobe tcp_bbr',
    'install -m 644 "$MOD" "$TARGET_MOD"',
    'install -m 644 "$PERF" "$TARGET_PERF"',
    'install -m 644 "$NOFILE" "$TARGET_NOFILE"',
    'mkdir -p /etc/systemd/system.conf.d',
    'printf "%s\\n" "[Manager]" "DefaultLimitNOFILE=1048576" > "$TARGET_SYSTEMD"',
    '# Apply sysctl line-by-line so optional keys (buckets) can fail soft',
    'while IFS= read -r line || [ -n "$line" ]; do',
    '  case "$line" in',
    "    ''|\\#*) continue ;;",
    '  esac',
    '  key="${line%%=*}"; key="$(echo "$key" | xargs)"',
    '  val="${line#*=}"; val="$(echo "$val" | xargs)"',
    '  sysctl -w "$key=$val" >/dev/null 2>&1 || echo "sysctl_skip $key"',
    'done < "$PERF"',
    '[ "$(sysctl -n net.ipv4.tcp_congestion_control)" = "bbr" ]',
    '[ "$(sysctl -n net.core.default_qdisc)" = "fq" ]',
    '[ "$(sysctl -n net.core.rmem_max)" = "16777216" ]',
    '[ "$(sysctl -n net.core.wmem_max)" = "16777216" ]',
    '# Raise nofile on live VPN-related PIDs without restart',
    'for p in $(pgrep -x xray || true) $(pgrep -x dockerd || true) $(pgrep -x containerd || true); do',
    '  [ -n "$p" ] || continue',
    '  prlimit --pid="$p" --nofile=1048576:1048576 2>/dev/null || true',
    'done',
    'for p in $(pgrep -f "xray run|vpn-ws-relay|caddy" || true); do',
    '  [ -n "$p" ] || continue',
    '  prlimit --pid="$p" --nofile=1048576:1048576 2>/dev/null || true',
    'done',
    'for u in "${!BEFORE[@]}"; do',
    '  after="$(systemctl show -p MainPID --value "$u")"',
    '  [ "$after" = "${BEFORE[$u]}" ] || {',
    '    echo "UNEXPECTED_XRAY_RESTART $u ${BEFORE[$u]} -> $after" >&2',
    '    exit 1',
    '  }',
    'done',
    'ct="$(sysctl -n net.netfilter.nf_conntrack_max 2>/dev/null || echo na)"',
    'echo "SCALE_PERF_OK host=$(hostname) congestion=bbr qdisc=fq rmem=16m conntrack_max=$ct nofile=1048576 persist=yes xrayRestarted=false"',
    '',
  ].join('\n');
}

function run(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`timeout ${cmd}`));
    }, opts.timeoutMs || 120000);
    child.stdout.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error((stderr || stdout || `exit ${code}`).trim()));
    });
    child.on('error', reject);
  });
}

function sshArgs(origin) {
  const args = [
    '-o',
    'BatchMode=yes',
    '-o',
    'StrictHostKeyChecking=accept-new',
    '-o',
    'ConnectTimeout=25',
    '-o',
    'ServerAliveInterval=30',
    '-i',
    KEY,
  ];
  if (origin.jump) {
    args.push('-o', `ProxyCommand=ssh -o BatchMode=yes -i ${KEY} -W %h:%p ${JUMP}`);
  }
  args.push(`root@${origin.host}`);
  return args;
}

async function ssh(origin, remoteCmd) {
  return run('ssh', [...sshArgs(origin), remoteCmd]);
}

function b64(text) {
  return Buffer.from(text, 'utf8').toString('base64');
}

async function putFile(origin, remotePath, content) {
  await ssh(origin, `echo '${b64(content)}' | base64 -d > '${remotePath}' && chmod 644 '${remotePath}'`);
}

async function runRemoteScript(origin, scriptBody, remotePath) {
  await putFile(origin, remotePath, scriptBody);
  return ssh(origin, `bash '${remotePath}'`);
}

function selectHosts(argv) {
  const cdnOnly = argv.includes('--cdn-only');
  const relaysOnly = argv.includes('--relays-only');
  if (cdnOnly) return CDN_ORIGINS;
  if (relaysOnly) return RELAY_EDGES;
  return [...CDN_ORIGINS, ...RELAY_EDGES];
}

async function main() {
  const mode = process.argv[2] || 'apply';
  if (!['audit', 'apply'].includes(mode)) {
    console.error(
      'Usage: node scripts/apply-origin-tcp-performance.mjs [audit|apply] [--cdn-only|--relays-only]'
    );
    process.exit(2);
  }

  const hosts = selectHosts(process.argv.slice(3));
  const results = [];

  for (let hi = 0; hi < hosts.length; hi++) {
    const origin = hosts[hi];
    if (hi > 0) await new Promise((r) => setTimeout(r, 8000));
    process.stdout.write(`[${origin.group}/${origin.id} ${origin.host}] ${mode}... `);
    try {
      if (mode === 'audit') {
        const { stdout } = await runRemoteScript(origin, AUDIT_SH, '/tmp/audit-tcp-perf.sh');
        console.log('ok');
        const summary = stdout
          .trim()
          .split('\n')
          .filter((l) =>
            /^(cc|qdisc|mtu|rmem_max|wmem_max|somaxconn|file_max|nf_conntrack_|persist_)=/.test(l)
          )
          .join(' ');
        console.log('  ' + summary);
        results.push({ id: origin.id, group: origin.group, ok: true, summary, raw: stdout });
      } else {
        await putFile(origin, '/tmp/99-vpn-scale-performance.conf', PERF_CONF);
        await putFile(origin, '/tmp/tcp_bbr.conf', MODULE_CONF);
        await putFile(origin, '/tmp/99-vpn-nofile.conf', NOFILE_CONF);
        const { stdout: applyOut } = await runRemoteScript(origin, buildApplySh(), '/tmp/apply-scale-perf.sh');
        const { stdout: afterOut } = await runRemoteScript(origin, AUDIT_SH, '/tmp/audit-tcp-perf.sh');
        const line = applyOut.trim().split('\n').filter(Boolean).pop();
        const summary = afterOut
          .trim()
          .split('\n')
          .filter((l) =>
            /^(cc|qdisc|rmem_max|wmem_max|somaxconn|file_max|nf_conntrack_|persist_)=/.test(l)
          )
          .join(' ');
        console.log(line);
        console.log('  ' + summary);
        results.push({ id: origin.id, group: origin.group, ok: true, apply: line, summary });
      }
    } catch (err) {
      console.log('FAIL');
      console.error(`  ${err.message}`);
      results.push({ id: origin.id, group: origin.group, ok: false, error: err.message });
    }
  }

  const failed = results.filter((r) => !r.ok);
  console.log(JSON.stringify({ mode, ok: failed.length === 0, results }, null, 2));
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
