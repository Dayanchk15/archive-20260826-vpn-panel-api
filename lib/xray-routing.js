/** Block QUIC (UDP/443) so browsers fall back to TCP/TLS through the tunnel. */
export const BLOCK_QUIC_OUTBOUND = { protocol: 'blackhole', tag: 'block' };

export const BLOCK_QUIC_RULE = {
  type: 'field',
  network: 'udp',
  port: '443',
  outboundTag: 'block',
};

export function withBlockQuicRouting(config, extraRules = []) {
  const outbounds = Array.isArray(config.outbounds) ? [...config.outbounds] : [];
  if (!outbounds.some((o) => o.tag === 'block')) {
    outbounds.push(BLOCK_QUIC_OUTBOUND);
  }

  const existingRules = config.routing?.rules || [];
  const hasQuicBlock = existingRules.some(
    (r) => r.network === 'udp' && String(r.port) === '443' && r.outboundTag === 'block',
  );
  const rules = hasQuicBlock
    ? [...existingRules, ...extraRules]
    : [...existingRules, ...extraRules, BLOCK_QUIC_RULE];

  return {
    ...config,
    outbounds,
    routing: {
      domainStrategy: config.routing?.domainStrategy || 'AsIs',
      rules,
    },
  };
}
