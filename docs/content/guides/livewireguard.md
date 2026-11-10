---
title: LiveWireGuard Import
---

LiveWireGuard is a WireGuard client for iOS and macOS. It can provision its tunnel configuration directly from wg-easy: the user signs in with OIDC inside the app, and the app fetches its config from this panel — no QR code or config file download needed.

## Endpoint

The provisioning endpoint is:

```http
GET https://<your-domain>/api/livewireguard/config
```

The full URL (based on the address you are visiting the panel with) is also shown on the admin panel under **Admin Panel → General Settings → LiveWireGuard → Endpoint**. Fill it into the LiveWireGuard app's import wizard.

The endpoint must be reachable from the device running the app — in production that means HTTPS with a valid certificate.

/// note

The endpoint does not use wg-easy session authentication. Requests are authenticated with the OIDC tokens the app obtained from your identity provider.

///

## Setup

1. Configure OIDC login as described in [External Authentication](../advanced/config/external-authentication.md) (for Authentik see the [Authentik SSO guide](./authentik-sso.md)). The app and the panel can share the same identity provider.
2. Register the LiveWireGuard app as a **public client** in your identity provider:

    | Setting      | Value                                                          |
    | ------------ | -------------------------------------------------------------- |
    | Client ID    | `livewireguard` (or your own — see [Audience](#audience))      |
    | Flow         | Authorization Code + PKCE (S256), token endpoint auth: `none`  |
    | Redirect URI | `com.wuxichaorongtechnologycoltd.livewireguard:/oidc/callback` |
    | Scopes       | `openid profile email offline_access`                          |

3. Enable the feature: **Admin Panel → General Settings → LiveWireGuard → Enabled**.

## Audience

Every OIDC token carries an `aud` (audience) claim: the identity of the client the token was issued **for**. When the app calls the endpoint, wg-easy validates that claim and accepts the token if the audience is either

- the **Audience** configured in the panel (default `livewireguard`), or
- the panel's OIDC client id (`OAUTH_OIDC_CLIENT_ID` or its override), or
- the **App Client ID** set under **Admin Panel → OIDC** (see below).

ID tokens are accepted when their audience is the panel client id or the App Client ID.

So set the panel's **Audience** field to the client id your identity provider actually stamps into the app's tokens. If you registered the app with client id `livewireguard`, the default already matches. If it is something else — or if your provider reuses the panel's client — adjust the field accordingly. A mismatch makes the endpoint answer `401 invalid_token`.

## User mapping

The endpoint matches the OIDC identity to a wg-easy account exactly like panel login does:

1. by the OIDC subject (`sub`) of a previously linked account,
2. otherwise by the account's email, if the token marks the email as verified.

If no account matches, the request is rejected with `403 forbidden` — accounts are never created through this endpoint (enable `OAUTH_AUTO_REGISTER` to have panel login create them).

## Provisioned clients

The first sync creates one wg-easy client per device, named `LiveWireGuard-<device id prefix>`, and returns its configuration to that device only. The private key never leaves the phone: the app generates it locally, uploads the public key, and the downloaded config intentionally contains **no `PrivateKey` line** — the app pairs the config with its own key.

In the panel these clients show a **LiveWireGuard** badge, and the QR code / config download actions are hidden because downloading the config would be useless without the private key.

If the device is reinstalled it gets a new device id and a new key; the next sync rotates the public key of the existing client so the client (and its IP address) is kept.

## Disabling and revocation

- Disable a single device: set the client to disabled in the panel. The next sync answers `410 Gone`, which the app treats as a final revocation and removes the tunnel.
- Turn the feature off entirely: the endpoint answers `404` (a transient state for the app) and panel login is unaffected.
- Requests are rate limited to 60 per minute per IP (`429 Too Many Requests` with `Retry-After`).

Responses are cached by the app and revalidated with an `ETag` (`If-None-Match` → `304 Not Modified`), so periodic syncs are cheap. Any configuration change on the panel — addresses, DNS, endpoint, allowed IPs — changes the ETag and the app picks it up on the next sync.

## OIDC settings in the admin panel

**Admin Panel → OIDC** overrides the `OAUTH_OIDC_*` environment variables at runtime. Every field falls back to the environment (or a default) when it is left empty, and changes apply immediately without a restart.

| Field             | Environment / default                                          |
| ----------------- | -------------------------------------------------------------- |
| Enabled           | `OAUTH_PROVIDERS` contains `oidc`                              |
| Display Name      | `OAUTH_OIDC_NAME`, default `OIDC`                              |
| Issuer / Server   | `OAUTH_OIDC_SERVER`                                            |
| Client ID         | `OAUTH_OIDC_CLIENT_ID`                                         |
| Client Secret     | `OAUTH_OIDC_CLIENT_SECRET`                                     |
| App Client ID     | the panel Client ID                                            |
| App Client Secret | the panel Client Secret when App Client ID is empty, else none |
| Scopes            | `openid profile email offline_access`                          |
| App Redirect URI  | `com.wuxichaorongtechnologycoltd.livewireguard:/oidc/callback` |
| Endpoint URL      | `<current origin>/api/livewireguard/config`                    |

Secrets are write-only: the panel never displays them. They are stored in plain text in the SQLite database, like the session secret. OIDC counts as configured when it is enabled and server, client id and client secret are all set. With `DISABLE_PASSWORD_AUTH=true` the panel refuses to save settings that would leave no way to log in.

## Setup QR code

Instead of filling in the import wizard by hand, the app can scan a setup QR code inside the app. It is shown to every logged-in user on the home page (**Connect → LiveWireGuard setup**) and previewed under **Admin Panel → OIDC**. When OIDC is not configured a placeholder is shown instead.

The QR code encodes a link: `livewireguard://setup?d=<base64url(JSON)>`. Next to the QR code the home page offers **Open in LiveWireGuard** (opens the same link, handy on a Mac where the browser and the app run on the same machine) and **Copy link**. On macOS the app can also read the link, or a screenshot of the QR code, from the clipboard (⌘V in the scan dialog). The iOS system camera opens the app directly.

/// note
Base64url is an encoding, not encryption. It only keeps the content from being readable at a glance; anyone with the link can decode it.
///

The decoded `d` value is a JSON document (UTF-8). Older apps and tools may also see the bare JSON. Empty fields are omitted:

```json
{
    "type": "livewireguard-setup",
    "v": 1,
    "name": "OIDC",
    "issuer": "https://idp.example.com/application/o/wg-easy/",
    "client_id": "livewireguard",
    "client_secret": "only-for-confidential-clients",
    "scopes": ["openid", "profile", "email", "offline_access"],
    "redirect_uri": "com.wuxichaorongtechnologycoltd.livewireguard:/oidc/callback",
    "endpoint": "https://vpn.example.com/api/livewireguard/config"
}
```

| Key             | Meaning                                                                 |
| --------------- | ----------------------------------------------------------------------- |
| `type`, `v`     | always `livewireguard-setup` / `1`; apps should reject unknown versions |
| `name`          | display name of the identity provider                                   |
| `issuer`        | issuer from OIDC discovery (falls back to the configured server URL)    |
| `client_id`     | client id the app signs in with                                         |
| `client_secret` | only present when a secret is configured for that client                |
| `scopes`        | scopes to request                                                       |
| `redirect_uri`  | redirect URI registered for the app                                     |
| `endpoint`      | full URL of the provisioning endpoint                                   |

/// warning
The QR code includes the client secret when one is configured. Anyone who can see the home page can read it. Prefer registering the app as a public client (no secret) with its own **App Client ID**.
///

## Personal WireGuard config QR code

Next to the setup QR code, the home page shows a regular WireGuard config QR code for the logged-in user, which any WireGuard app can import:

- It shows the user's current client: the one created last with **Regenerate**, otherwise the user's oldest client that has a private key. LiveWireGuard device clients are skipped because they have no private key on the server.
- No client is created automatically. Without a client a placeholder and a **Generate** button are shown.
- **Regenerate** creates a new client with a new key pair for the current user (any role) and makes it the current one. Older clients are kept. This is limited to 5 per minute per user.
- **Refresh** reloads both QR codes. They also refresh every 5 seconds and after changes in the client list, and the QR code image URL contains a hash of the full config, so the QR code always matches the current configuration (client settings, host, port, DNS, allowed IPs, ...). Users only ever see their own client.
