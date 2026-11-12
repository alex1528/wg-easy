/**
 * A UUID as sent by the LiveWireGuard app in the X-Device-Id header
 */
const DEVICE_ID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A base64 encoded 32 byte Curve25519 key (43 chars + '='), as sent by the
 * LiveWireGuard app in the X-Public-Key header. The 43rd character carries
 * 4 significant bits (2 zero padded), so it must be a multiple of 4.
 */
const PUBLIC_KEY_REGEX = /^[A-Za-z0-9+/]{42}[AEIMQUYcgkosw048]=$/;

export function isValidDeviceId(deviceId: string) {
  return DEVICE_ID_REGEX.test(deviceId);
}

export function isValidPublicKey(publicKey: string) {
  return PUBLIC_KEY_REGEX.test(publicKey);
}
