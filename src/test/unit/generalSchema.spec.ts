import { describe, expect, test } from 'vitest';

import { GeneralUpdateRequestSchema } from '#db/repositories/general/types';

const base = {
  sessionTimeout: 3600,
  metricsPrometheus: false,
  metricsJson: false,
  metricsPassword: null,
  liveWireGuardEnabled: true,
  liveWireGuardAudience: 'livewireguard',
  maxClientsPerUser: 5,
};

describe('GeneralUpdateRequestSchema liveWireGuardEndpointUrl', () => {
  test('optional: undefined keeps the stored value', () => {
    const r = GeneralUpdateRequestSchema.parse(base);
    expect(r.liveWireGuardEndpointUrl).toBeUndefined();
  });

  test('null and empty string reset to the default', () => {
    expect(
      GeneralUpdateRequestSchema.parse({
        ...base,
        liveWireGuardEndpointUrl: null,
      }).liveWireGuardEndpointUrl
    ).toBeNull();
    expect(
      GeneralUpdateRequestSchema.parse({
        ...base,
        liveWireGuardEndpointUrl: '   ',
      }).liveWireGuardEndpointUrl
    ).toBeNull();
  });

  test('accepts http(s) urls and trims them', () => {
    expect(
      GeneralUpdateRequestSchema.parse({
        ...base,
        liveWireGuardEndpointUrl:
          ' https://vpn.example.com/wg/api/livewireguard/config ',
      }).liveWireGuardEndpointUrl
    ).toBe('https://vpn.example.com/wg/api/livewireguard/config');
    expect(
      GeneralUpdateRequestSchema.safeParse({
        ...base,
        liveWireGuardEndpointUrl: 'http://10.0.0.1:51821/api/livewireguard/config',
      }).success
    ).toBe(true);
  });

  test('rejects invalid urls', () => {
    for (const value of [
      'not a url',
      'vpn.example.com/api/livewireguard/config',
      'ftp://vpn.example.com/config',
      'livewireguard://setup',
      `https://example.com/${'a'.repeat(2048)}`,
    ]) {
      expect(
        GeneralUpdateRequestSchema.safeParse({
          ...base,
          liveWireGuardEndpointUrl: value,
        }).success
      ).toBe(false);
    }
  });

  test('the general fields are still validated', () => {
    expect(
      GeneralUpdateRequestSchema.safeParse({ ...base, sessionTimeout: 'x' })
        .success
    ).toBe(false);
  });
});

describe('GeneralUpdateRequestSchema maxClientsPerUser', () => {
  test('accepts 0 (unlimited) to 1000', () => {
    for (const value of [0, 1, 5, 1000]) {
      expect(
        GeneralUpdateRequestSchema.parse({ ...base, maxClientsPerUser: value })
          .maxClientsPerUser
      ).toBe(value);
    }
  });

  test('rejects negative, too large, decimals, strings and missing', () => {
    for (const value of [-1, 1001, 2.5, '5', '', null]) {
      expect(
        GeneralUpdateRequestSchema.safeParse({
          ...base,
          maxClientsPerUser: value,
        }).success
      ).toBe(false);
    }
    const { maxClientsPerUser: _, ...missing } = base;
    expect(GeneralUpdateRequestSchema.safeParse(missing).success).toBe(false);
  });
});
