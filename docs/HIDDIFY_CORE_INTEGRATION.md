# Hiddify Core integration gate for DADA VPN

Status: prepared, not enabled.

The Android application now reaches its packet-tunnel implementation only through
`VpnEngine`. The current fallback is `XrayVpnEngine`; UI, profile loading, server
selection, reconnects and connection verification do not depend on that class.

No Hiddify AAR, source file or derived binary is stored in this repository. The
official artifact must not be copied into `android-client/app/libs` until its
rights holder gives written permission which explicitly covers distribution in a
closed-source DADA VPN APK.

## Permission record required before implementation

Keep an internal copy of the permission and verify that it covers:

- closed-source/confidential Android distribution;
- free distribution to DADA VPN users;
- modification or use of an adapter around the library;
- redistribution of the native libraries for every shipped ABI;
- required attribution, notices and update obligations;
- whether the permission is limited by application ID, company or release term.

If the permission requires a commercial agreement or a different license, that
agreement takes precedence over the public repository license. Do not store the
agreement or credentials in the application repository.

## Planned adapter

After permission is confirmed:

1. Pin one approved Hiddify Core release and record the original download URL and
   SHA-256 in the private release procedure.
2. Add a local dependency without committing the AAR. CI receives it from a
   restricted artifact store.
3. Implement `HiddifyVpnEngine : VpnEngine` using only the approved public Android
   API. It owns its TUN descriptor and delegates Android-only operations through
   `VpnTunnelHost`.
4. Map the panel's internal `VpnTransport` to an in-memory engine configuration.
   Never expose, export or log UUIDs, tokens, hosts or generated configurations.
5. Switch the implementation only in `VpnEngineFactory` after device tests pass.
   Keep the Xray adapter available during the pilot for rollback.

The existing server API remains authoritative. Changing, adding or disabling a
server in the panel must not require a new APK as long as the transport type is
already supported by the installed engine.

## Acceptance checks

- Android 8, 10, 12, 14, 15 and 16 device/emulator coverage where available;
- production VLESS + WebSocket + TLS masking traffic, not just tunnel startup;
- DNS, IPv4 and IPv6 leak checks;
- Wi-Fi/mobile handover, screen-off operation and process restart;
- manual and automatic server selection, node ping and failover;
- revoked/disabled profile immediately stops the tunnel;
- arm64 release size and cold-start memory measurement;
- no secrets or raw configuration in Logcat, crash reports or diagnostics;
- release license notices match the written permission.

An Android AAR does not provide an iOS implementation. Any future iOS client needs
its own Network Extension integration, signing, license review and device tests.
