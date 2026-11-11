---
title: Users and Roles
---

wg-easy has two roles:

| Role  | Can do                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------- |
| Admin | Manage all users, all clients and every setting in the Admin Panel                                        |
| User  | See their own clients, rename or delete them, download their configuration and use the self service setup |

Users can't create clients in the panel, enable / disable clients or change addresses, allowed IPs, firewall, DNS, MTU, AmneziaWG parameters, hooks or the expiry date. These settings are shown read only.

## Initial Admin

The user created by the setup wizard (or by `INIT_USERNAME` / `INIT_PASSWORD`, see [Unattended Setup](../advanced/config/unattended-setup.md)) is always an admin.

## Managing Users

Admins can manage users in **Admin Panel → Users**:

- see every user with their role, login methods, number of clients, status and last login
- **Make admin** / **Make user**
- **Follow OIDC groups**: let the OIDC group mapping manage the role again (see below)
- **Disable** / **Enable**: a disabled user can't log in and the WireGuard peers of their clients are removed from the server until the user is enabled again

To prevent lockouts:

- you can't change your own account
- there is always at least one enabled admin: demoting or disabling the last one is rejected

If a user loses the admin role while having the Admin Panel open, their next action fails and they are sent back to the client list.

## Client Limit

**Admin Panel → General → Clients → Max Clients per User** limits how many clients a user can create themselves. The default is `5`, `0` means unlimited.

- Counted: every client of the user, enabled or disabled
- Limited: the **Generate** / **Regenerate** button of the home page QR code and new LiveWireGuard devices (the endpoint answers `409 device_limit_reached`, the app retries later). A device that logs in again keeps its client and is not counted twice
- Not limited: admins, and clients an admin creates for a user in the panel (the dialog shows a hint when the owner is at the limit)
- Lowering the limit keeps existing clients; the user can only create new ones after deleting old clients

The home page shows the usage (`3 / 5 clients used`) and the users page shows it for every user.

## Role Source

Every user has a role source:

| Source      | Meaning                                                                                     |
| ----------- | ------------------------------------------------------------------------------------------- |
| Manual      | Set by the setup, an admin or the CLI. Never changed by OIDC groups                         |
| OIDC groups | Recalculated from the OIDC groups on every OIDC login (see [Role Mapping](#oidc-role-mapping)) |

Changing the role in the Admin Panel always sets the source to _Manual_. Use **Follow OIDC groups** to switch back.

Linking an existing local account with OIDC keeps its role and source.

## OIDC Role Mapping

In **Admin Panel → OIDC → Role Mapping** (or with environment variables) you can configure OIDC groups that grant the admin role.

| Setting            | Env                       | Default                | Description                                                                 |
| ------------------ | ------------------------- | ---------------------- | --------------------------------------------------------------------------- |
| Admin Groups       | `OAUTH_OIDC_ADMIN_GROUPS` | -                      | Comma separated. Members of any of these groups are admins                  |
| Groups Claim       | `OAUTH_OIDC_GROUPS_CLAIM` | `groups`               | Claim containing the groups. Dotted paths (`realm_access.roles`) are supported |
| Panel Login Scopes | `OAUTH_OIDC_SCOPES`       | `openid email profile` | Scopes requested by the panel login. Must contain `openid`                  |

Values saved in the Admin Panel override the environment.

Rules:

- **New OIDC users** (see `OAUTH_AUTO_REGISTER`) are admins if they are member of an admin group, otherwise users
- **Users following the OIDC groups** are recalculated on every OIDC login: they are promoted or demoted
- **Users with a manual role** are never changed
- If the groups claim is **missing**, the role is not changed and a warning is logged
- If **no admin groups** are configured, existing users keep their role and new users are users
- The **last enabled admin** is never demoted

Groups are read from the id token and the userinfo response (userinfo wins). Group names are case sensitive, a leading `/` is ignored. The groups of the last OIDC login are shown in **Users** (_Show groups_), and the OIDC page shows the groups of your own last login.

After changing the admin groups, **Recalculate roles now** applies them to every user following the OIDC groups, based on the groups of their last login. Otherwise the change applies on the next login of each user.

### Provider Notes

- **Authentik**: groups are in the `groups` claim of the `profile` scope. Use the group names.
- **Keycloak**: add a _Group Membership_ mapper (claim name `groups`) to the client scope. With _Full group path_ enabled, groups are sent as `/name`; this is matched as `name`. For realm roles use the claim `realm_access.roles`.
- **Authelia**: groups are in the `groups` claim; add the `groups` scope to the client and to _Panel Login Scopes_.
- **Okta**: create a `groups` claim in the authorization server and add the `groups` scope to _Panel Login Scopes_.
- **Microsoft Entra ID**: enable the groups claim in _Token configuration_. Entra ID sends group object ids (GUIDs), use these as admin groups. Users in more than 200 groups get no groups claim (overage), their role is not changed.
- **Auth0**: add the groups with an action as a namespaced claim and use it as the claim, e.g. `https://example.com/groups`.

## Recovery

If no admin can log in anymore, use the [CLI](cli.md):

```shell
cli db:user:list
cli db:user:promote --username <username>
```
