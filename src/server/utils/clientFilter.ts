import { createDebug } from 'obug';

import { exec } from '#server/utils/cmd';
import type { InterfaceType } from '#db/repositories/interface/types';

const CF_DEBUG = createDebug('ClientFilter');
const CHAIN_NAME = 'WG_MAGIC';

/** The 16-byte identification magic own clients write into the mac2 field. */
export const WG_CLIENT_MAGIC = 'LiveWG-Magic0001';

/**
 * Tie chains to a specific interface
 * Prevents instances in the same network namespace from wiping each other's rules
 */
function chainName(interfaceName: string) {
  return `${CHAIN_NAME}_${interfaceName}`;
}

// Mutex to prevent concurrent rule rebuilds
let rebuildInProgress = false;
let rebuildQueued = false;

// Cache availability check result
let u32Available: boolean | null = null;

/**
 * Packet math for WireGuard handshake initiations.
 *
 * A WireGuard handshake initiation is a 148-byte UDP payload. Its last 16
 * bytes are the mac2 field. Generic clients (official WireGuard, the official
 * AmneziaWG app, …) always send mac2 as all-zero bytes. Own clients
 * (LiveWireGuard, C++ core) write a 16-byte identification magic into mac2
 * instead: "LiveWG-Magic0001".
 *
 * This filter is an explicit ALLOWLIST: a handshake initiation carrying the
 * magic is RETURNed back to INPUT for normal processing (where wg-easy's own
 * PostUp ACCEPT rule lets it through); EVERY other initiation is dropped —
 * zero mac2, foreign mac2, anything. Do not weaken this back to "drop zero
 * mac2": a blacklist would let through any client that merely sets mac2 to
 * some non-zero value.
 *
 * Caveat: if the server ever switches to cookie mode under load, an own
 * client's retry replaces the magic with a real cookie in mac2 and would be
 * dropped by the allowlist. In that rare case the client simply keeps
 * retrying with the magic until load subsides.
 *
 * Absolute byte offsets (counted from the start of the IP header, as used by
 * the xt_u32 match):
 *   IPv4: 20-byte IP header (options unsupported by this filter, assumed 0)
 *         + 8-byte UDP header → UDP payload starts at 28.
 *         type byte = 28, mac2 = 160..175, total length = 176.
 *   IPv6: 40-byte fixed header + 8-byte UDP header → payload starts at 48.
 *         type byte = 48, mac2 = 180..195, total length = 196.
 *         (extension headers would shift offsets — IPv6 filtering is
 *         best-effort for that reason)
 *
 * The u32 expression `OFF>>24&0xFF=1` reads the first byte of the 4-byte word
 * at OFF (the WireGuard message-type byte: 1 = handshake initiation). The
 * expressions `OFF2&0xFFFFFFFF=0x…` verify 4 magic bytes each, together
 * matching the full 16-byte magic. Transport data (type 4) and any other
 * traffic to the port never match the type-byte test, so they cannot be
 * dropped by mistake; the chain-end falls through to normal INPUT handling.
 */

/** The 16 magic bytes as 4 big-endian u32 hex words ("Live","WG-M","agic","0001"). */
function magicWords(): string[] {
  const words: string[] = [];
  for (let i = 0; i < WG_CLIENT_MAGIC.length; i += 4) {
    let value = 0;
    for (const ch of WG_CLIENT_MAGIC.slice(i, i + 4)) {
      value = (value << 8) | (ch.charCodeAt(0) & 0xff);
    }
    words.push(`0x${value.toString(16)}`);
  }
  return words;
}

/** u32 tests matching "handshake initiation whose mac2 is the client magic". */
export function generateMagicMac2U32Tests(payloadStart: number): string {
  const typeTest = `${payloadStart}>>24&0xFF=1`;
  const mac2Start = payloadStart + 132;
  const magicTests = magicWords()
    .map((word, i) => `${mac2Start + i * 4}&0xFFFFFFFF=${word}`)
    .join(' && ');
  return `${typeTest} && ${magicTests}`;
}

/** u32 tests matching "any handshake initiation" (type byte = 1). */
export function generateInitiationTypeTest(payloadStart: number): string {
  return `${payloadStart}>>24&0xFF=1`;
}

/**
 * Generate the iptables rule arguments for one family.
 * Returned strings are meant to be run as `iptables ${rule}` / `ip6tables ${rule}`.
 * Order matters: the RETURN (magic) rule must come before the DROP rule.
 */
export function generateWhitelistRules(
  interfaceName: string,
  port: number,
  enableIpv6: boolean
): string[] {
  const length = enableIpv6 ? 196 : 176;
  const payloadStart = enableIpv6 ? 48 : 28;
  const chain = chainName(interfaceName);
  return [
    `-A ${chain} -p udp --dport ${port} -m length --length ${length} -m u32 --u32 "${generateMagicMac2U32Tests(payloadStart)}" -j RETURN`,
    `-A ${chain} -p udp --dport ${port} -m length --length ${length} -m u32 --u32 "${generateInitiationTypeTest(payloadStart)}" -j DROP`,
  ];
}

export const clientFilter = {
  /**
   * Create the chain and the INPUT jump rule if they don't exist.
   * The jump sits at INPUT position 1, i.e. before wg-easy's own PostUp
   * `iptables -A INPUT -p udp --dport <port> -j ACCEPT` rule.
   */
  async initChain(interfaceName: string, port: number, enableIpv6: boolean) {
    const chain = chainName(interfaceName);
    CF_DEBUG(
      `Initializing client filter chain ${chain} for interface ${interfaceName}`
    );

    await exec(`iptables -N ${chain} 2>/dev/null || true`);
    await exec(
      `iptables -C INPUT -p udp --dport ${port} -j ${chain} 2>/dev/null || iptables -I INPUT 1 -p udp --dport ${port} -j ${chain}`
    );
    if (enableIpv6) {
      await exec(`ip6tables -N ${chain} 2>/dev/null || true`);
      await exec(
        `ip6tables -C INPUT -p udp --dport ${port} -j ${chain} 2>/dev/null || ip6tables -I INPUT 1 -p udp --dport ${port} -j ${chain}`
      );
    }
  },

  /**
   * Flush all rules in the chain (making it a no-op passthrough).
   */
  async flushChain(interfaceName: string, enableIpv6: boolean) {
    const chain = chainName(interfaceName);
    CF_DEBUG(`Flushing client filter chain ${chain}`);
    await exec(`iptables -F ${chain} 2>/dev/null || true`);
    if (enableIpv6) {
      await exec(`ip6tables -F ${chain} 2>/dev/null || true`);
    }
  },

  /**
   * Full rebuild of the client filter rules from database state.
   * No-op passthrough when the feature is disabled.
   */
  async rebuildRules(wgInterface: InterfaceType, enableIpv6: boolean) {
    if (!wgInterface.clientFilterEnabled) {
      CF_DEBUG('Client filter disabled, removing any existing rules');
      await this.removeFiltering(
        wgInterface.name,
        wgInterface.port,
        enableIpv6
      );
      return;
    }

    // Handle concurrent rebuilds with queue
    if (rebuildInProgress) {
      CF_DEBUG('Rebuild already in progress, queuing');
      rebuildQueued = true;
      return;
    }

    rebuildInProgress = true;

    try {
      CF_DEBUG('Rebuilding client filter rules...');

      await this.initChain(wgInterface.name, wgInterface.port, enableIpv6);
      await this.flushChain(wgInterface.name, enableIpv6);

      for (const rule of generateWhitelistRules(
        wgInterface.name,
        wgInterface.port,
        false
      )) {
        await exec(`iptables ${rule}`);
      }
      if (enableIpv6) {
        for (const rule of generateWhitelistRules(
          wgInterface.name,
          wgInterface.port,
          true
        )) {
          await exec(`ip6tables ${rule}`);
        }
      }

      CF_DEBUG('Client filter rules rebuilt successfully');
    } finally {
      rebuildInProgress = false;

      // If another rebuild was queued, run it now
      if (rebuildQueued) {
        rebuildQueued = false;
        CF_DEBUG('Processing queued rebuild');
        await this.rebuildRules(wgInterface, enableIpv6);
      }
    }
  },

  /**
   * Remove all client filtering (when the feature is disabled)
   */
  async removeFiltering(
    interfaceName: string,
    port: number,
    enableIpv6: boolean
  ) {
    const chain = chainName(interfaceName);
    CF_DEBUG(`Removing client filter for interface ${interfaceName}`);

    await exec(
      `iptables -D INPUT -p udp --dport ${port} -j ${chain} 2>/dev/null || true`
    );
    await exec(`iptables -F ${chain} 2>/dev/null || true`);
    await exec(`iptables -X ${chain} 2>/dev/null || true`);
    if (enableIpv6) {
      await exec(
        `ip6tables -D INPUT -p udp --dport ${port} -j ${chain} 2>/dev/null || true`
      );
      await exec(`ip6tables -F ${chain} 2>/dev/null || true`);
      await exec(`ip6tables -X ${chain} 2>/dev/null || true`);
    }
  },

  /**
   * Check whether iptables (+ ip6tables when IPv6 is on) with the xt_u32
   * match is available on the system.
   */
  async isAvailable(enableIpv6: boolean = true): Promise<boolean> {
    if (u32Available !== null) {
      return u32Available;
    }

    try {
      await exec('iptables -m u32 -h');
      CF_DEBUG('iptables with u32 match is available');

      if (enableIpv6) {
        await exec('ip6tables -m u32 -h');
        CF_DEBUG('ip6tables with u32 match is available');
      }

      u32Available = true;
      return true;
    } catch (error) {
      u32Available = false;
      CF_DEBUG('iptables/ip6tables with u32 match is not available:', error);
      return false;
    }
  },

  /**
   * Clear the availability cache to force a re-check
   */
  clearAvailabilityCache(): void {
    u32Available = null;
  },
};

export const clientFilterTestExports = {
  chainName,
  magicWords,
  generateMagicMac2U32Tests,
  generateInitiationTypeTest,
  generateWhitelistRules,
};
