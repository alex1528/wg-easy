import { beforeEach, describe, expect, test, vi } from 'vitest';

import { exec } from '#server/utils/cmd';
import {
  clientFilter,
  clientFilterTestExports,
} from '#server/utils/clientFilter';

vi.mock('#server/utils/cmd', () => ({
  exec: vi.fn().mockResolvedValue(''),
}));

const execMock = vi.mocked(exec);

describe('clientFilter', () => {
  beforeEach(() => {
    execMock.mockClear();
    clientFilter.clearAvailabilityCache();
  });

  describe('rule generation', () => {
    test('magic words encode "LiveWG-Magic0001" as 4 big-endian u32 words', () => {
      expect(clientFilterTestExports.magicWords()).toEqual([
        '0x4c697665', // "Live"
        '0x57472d4d', // "WG-M"
        '0x61676963', // "agic"
        '0x30303031', // "0001"
      ]);
    });

    test('ipv4 whitelist is RETURN-on-magic followed by DROP-on-any-initiation', () => {
      const rules = clientFilterTestExports.generateWhitelistRules(
        'wg0',
        51820,
        false
      );

      expect(rules).toHaveLength(2);
      // UDP payload 148 bytes → IP total length 176 (20 IP + 8 UDP + 148)
      for (const rule of rules) {
        expect(rule).toContain('-m length --length 176');
        expect(rule).toContain('-A WG_MAGIC_wg0');
        expect(rule).toContain('--dport 51820');
        // type byte (initiation = 1) at payload start 28
        expect(rule).toContain('28>>24&0xFF=1');
      }
      // rule 1: mac2 must carry the magic (absolute offsets 160..175)
      expect(rules[0]).toContain('-j RETURN');
      expect(rules[0]).toContain('160&0xFFFFFFFF=0x4c697665');
      expect(rules[0]).toContain('164&0xFFFFFFFF=0x57472d4d');
      expect(rules[0]).toContain('168&0xFFFFFFFF=0x61676963');
      expect(rules[0]).toContain('172&0xFFFFFFFF=0x30303031');
      // rule 2: any other initiation (zero or foreign mac2) is dropped
      expect(rules[1]).toContain('-j DROP');
    });

    test('ipv6 whitelist uses ipv6 offsets and 196 byte length', () => {
      const rules = clientFilterTestExports.generateWhitelistRules(
        'wg0',
        51820,
        true
      );

      expect(rules).toHaveLength(2);
      expect(rules[0]).toContain('-m length --length 196');
      expect(rules[1]).toContain('-m length --length 196');
      // type byte at payload start 48 (40 IPv6 + 8 UDP)
      expect(rules[0]).toContain('48>>24&0xFF=1');
      expect(rules[1]).toContain('48>>24&0xFF=1');
      // mac2 at absolute 180..195
      expect(rules[0]).toContain('180&0xFFFFFFFF=0x4c697665');
      expect(rules[0]).toContain('192&0xFFFFFFFF=0x30303031');
      expect(rules[0]).toContain('-j RETURN');
      expect(rules[1]).toContain('-j DROP');
    });

    test('magic u32 tests only match initiations with the exact magic', () => {
      const tests = clientFilterTestExports.generateMagicMac2U32Tests(28);
      // 1 type test + 4 magic word tests
      expect(tests.split('&&')).toHaveLength(5);
      expect(tests).toContain('160&0xFFFFFFFF=0x4c697665');
      // a foreign non-zero mac2 must NOT pass: words are exact hex equality
      // (=0 only as the prefix of a 0x… hex literal is fine)
      expect(tests.match(/&0xFFFFFFFF=0(?!x)/g)).toBeNull();
    });

    test('type test matches any initiation regardless of mac2', () => {
      expect(clientFilterTestExports.generateInitiationTypeTest(28)).toBe(
        '28>>24&0xFF=1'
      );
    });

    test('chain name is interface specific', () => {
      expect(clientFilterTestExports.chainName('wg0')).toBe('WG_MAGIC_wg0');
      expect(clientFilterTestExports.chainName('wg1')).toBe('WG_MAGIC_wg1');
    });
  });

  describe('chain management', () => {
    test('init creates chain and jumps before existing INPUT rules', async () => {
      await clientFilter.initChain('wg0', 51820, false);

      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('iptables -N WG_MAGIC_wg0')
      );
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining(
          'iptables -C INPUT -p udp --dport 51820 -j WG_MAGIC_wg0 2>/dev/null || iptables -I INPUT 1 -p udp --dport 51820 -j WG_MAGIC_wg0'
        )
      );
      expect(execMock).not.toHaveBeenCalledWith(
        expect.stringContaining('ip6tables')
      );
    });

    test('init also handles ipv6 when enabled', async () => {
      await clientFilter.initChain('wg0', 51820, true);

      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('ip6tables -N WG_MAGIC_wg0')
      );
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('ip6tables -I INPUT 1')
      );
    });

    test('rebuildRules removes chain when disabled', async () => {
      await clientFilter.rebuildRules(
        {
          name: 'wg0',
          port: 51820,
          clientFilterEnabled: false,
        } as never,
        false
      );

      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining(
          'iptables -D INPUT -p udp --dport 51820 -j WG_MAGIC_wg0'
        )
      );
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('iptables -X WG_MAGIC_wg0')
      );
    });

    test('rebuildRules installs whitelist rules when enabled', async () => {
      await clientFilter.rebuildRules(
        {
          name: 'wg0',
          port: 51820,
          clientFilterEnabled: true,
        } as never,
        false
      );

      expect(execMock).toHaveBeenCalledWith(expect.stringContaining('-m u32'));
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('-j RETURN')
      );
      expect(execMock).toHaveBeenCalledWith(expect.stringContaining('-j DROP'));
      expect(execMock).not.toHaveBeenCalledWith(
        expect.stringContaining('ip6tables')
      );
    });

    test('removeFiltering cleans chain and jump for both families', async () => {
      await clientFilter.removeFiltering('wg0', 51820, true);

      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining(
          'iptables -D INPUT -p udp --dport 51820 -j WG_MAGIC_wg0'
        )
      );
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining(
          'ip6tables -D INPUT -p udp --dport 51820 -j WG_MAGIC_wg0'
        )
      );
      expect(execMock).toHaveBeenCalledWith(
        expect.stringContaining('ip6tables -X WG_MAGIC_wg0')
      );
    });
  });

  describe('availability', () => {
    test('isAvailable false when u32 match missing', async () => {
      execMock.mockRejectedValueOnce(new Error('not found'));
      expect(await clientFilter.isAvailable(false)).toBe(false);
    });

    test('isAvailable true when u32 match works and result is cached', async () => {
      expect(await clientFilter.isAvailable(false)).toBe(true);
      // second call uses cache → same number of exec calls
      const callsAfterFirst = execMock.mock.calls.length;
      expect(await clientFilter.isAvailable(false)).toBe(true);
      expect(execMock.mock.calls.length).toBe(callsAfterFirst);
    });

    test('clearAvailabilityCache forces re-check', async () => {
      expect(await clientFilter.isAvailable(false)).toBe(true);
      const callsAfterFirst = execMock.mock.calls.length;
      clientFilter.clearAvailabilityCache();
      expect(await clientFilter.isAvailable(false)).toBe(true);
      expect(execMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
    });
  });
});
