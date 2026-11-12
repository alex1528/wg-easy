/**
 * Pure helpers for the user's "connect" client (QR code B on the home page).
 */

type ConnectCandidate = {
  id: number;
  deviceId: string | null;
  privateKey: string;
  isDefault: boolean;
};

/** only panel clients with a known private key can be imported via QR */
export function isImportableClient(client: ConnectCandidate) {
  return client.deviceId === null && client.privateKey !== '';
}

/**
 * The client marked as default, otherwise the oldest importable one.
 */
export function pickConnectClient<T extends ConnectCandidate>(
  clients: readonly T[]
): T | null {
  const importable = clients.filter(isImportableClient);
  const marked = importable.filter((c) => c.isDefault);
  const pool = marked.length > 0 ? marked : importable;
  let result: T | null = null;
  for (const c of pool) {
    if (result === null || c.id < result.id) {
      result = c;
    }
  }
  return result;
}

function pad(n: number) {
  return n.toString().padStart(2, '0');
}

/** `${username}-yyyyMMdd-HHmm` (local time of the server) */
export function connectClientName(username: string, date = new Date()) {
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(
    date.getDate()
  )}-${pad(date.getHours())}${pad(date.getMinutes())}`;
  const base = username.trim() || 'client';
  return `${base}-${stamp}`;
}
