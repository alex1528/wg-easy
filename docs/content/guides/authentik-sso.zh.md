---
title: Authentik SSO（中文）
---

English version: [Authentik SSO](./authentik-sso.md)

本指南介绍如何把 [Authentik](https://goauthentik.io) 配置为 wg-easy 的单点登录（SSO）提供方——既覆盖 Web 面板登录，也覆盖（可选的）LiveWireGuard App 的配置下发流程。

文中所有示例均使用脱敏占位值：

| 占位符                            | 含义                            |
| --------------------------------- | ------------------------------- |
| `https://vpn.example.com`         | wg-easy 面板地址                |
| `https://auth.example.com`        | Authentik 实例地址              |
| `<client-id>` / `<client-secret>` | 由 Authentik 生成的值——请勿外泄 |

前提条件：

- wg-easy 和 Authentik 都必须通过**带有效证书的 HTTPS** 访问（wg-easy 会拒绝没有有效证书的 OIDC 服务器）。
- 能访问 Authentik 管理界面（`https://auth.example.com/if/admin/`）。
- 至少有一个可用的 wg-easy 管理员账号（用于开启 OIDC 以及绑定账号）。

wg-easy 使用标准 OIDC：PKCE、`openid email profile` 作用域，客户端认证方式为 `client_secret_post`。这些 Authentik 原生支持。

## 总览：两个 OIDC 客户端

需要在 Authentik 里建两个独立的 Provider：

| 客户端     | 类型         | 用途                                                  | 密钥       |
| ---------- | ------------ | ----------------------------------------------------- | ---------- |
| 面板客户端 | Confidential | wg-easy Web 登录                                      | 有         |
| App 客户端 | Public       | LiveWireGuard App（见[导入指南](./livewireguard.md)） | 无（PKCE） |

App 客户端只有在使用 LiveWireGuard 配置下发端点时才需要；仅用面板的话可以不建。

## 第 1 步 — 创建自定义 email Scope Mapping

先做这一步，因为后面两个 Provider 都要用到它。

1. 打开 Authentik 管理界面 → **Customization** → **Property Mappings**（自定义 → 属性映射）。
2. 点击 **Create**，选择 **Scope Mapping**（作用域映射）。
3. 填写：

    | 字段        | 值                                                  |
    | ----------- | --------------------------------------------------- |
    | Name        | `wg-easy verified email`                            |
    | Scope name  | `email`                                             |
    | Description | `email scope with email_verified: true for wg-easy` |

4. 在 **Expression** 字段填入：

    ```python
    return {
        "email": user.email,
        "email_verified": True,
    }
    ```

5. 保存。Scope name 必须是精确的 `email`——它用来替换同名的内置映射。

### 为什么必须这样做

原因有两个，分别在 wg-easy 和 Authentik 两侧：

**wg-easy 要求邮箱是"已验证"状态。** 每次OIDC 登录都会读取 userinfo 响应，其中必须同时包含 `sub`、`email` 以及为真的 `email_verified`，否则登录直接失败并返回 `401 Email is not verified`（见 `src/server/utils/oauth.ts` 的 `assertHasOauthProps`）。这个标志同样影响账号匹配：令牌只能按 email 匹配时，只有 email 被标记为已验证才被 LiveWireGuard 端点接受（见[用户匹配](./livewireguard.md#user-mapping)）。`OAUTH_ALLOWED_DOMAINS` 的域名过滤也跑在这个 email 上——所以声明缺失或未验证时，登录在后续任何检查之前就已失败。

**Authentik 的默认映射发的是 `email_verified: false`。** 从 Authentik 2025.10 起，内置的 `authentik default OpenID Mapping: email` 把 `email_verified` 硬编码为 `False`，理由是"仅凭一个邮箱地址无法证明用户控制它"（2025.10 之前硬编码为 `True`——不管哪个版本，它都是一个固定值，并不反映用户真实的验证状态）。Authentik 对目录账号不追踪邮箱验证，所以也没有真实状态可以上报。结果就是：用默认映射时，Authentik 登录本身成功了，wg-easy 却报 `Email is not verified` 拒绝——这是最容易迷惑人的失败方式，因为用户明明完成了认证。

所以上面的表达式显式断言 `email_verified: True`。前提是 Authentik 目录里的每个账号邮箱都可信（公司统一建号的内部目录通常如此）。如果你的目录不满足这一点，请改用由用户属性驱动的更安全写法：

```python
return {
    "email": user.email,
    "email_verified": user.attributes.get("email_verified", False),
}
```

然后在 Authentik 里按用户或组设置 `email_verified` 属性。

/// warning

**不要**把默认 email 映射和自定义映射同时挂在同一个 Provider 上——作用域重叠会产生相互冲突的声明。Provider 挂了自定义映射后，要把 `authentik default OpenID Mapping: email` 从它的作用域选择里移除。

///

## 第 2 步 — 创建面板 Provider（机密客户端）

1. 管理界面 → **Applications** → **Providers** → **Create** → **OAuth2/OpenID Connect**。
2. 配置：

    | 字段                      | 值                                                           |
    | ------------------------- | ------------------------------------------------------------ |
    | Name                      | `wg-easy`                                                    |
    | Authorization flow        | _Authorize Application (with consent)_（默认的显式授权流程） |
    | Client type               | **Confidential**                                             |
    | Client ID / Secret        | 由 Authentik 自动生成——现在就复制保存                        |
    | Redirect/Post Logout URIs | 见下                                                         |
    | Signing key               | 任一可用密钥（默认即可）                                     |

3. Redirect URIs——两条各占一行：

    ```
    https://vpn.example.com/api/auth/oidc/callback
    https://vpn.example.com/api/auth/oidc/link
    ```

    - `.../callback` 用于正常登录。
    - `.../link` 用于已有用户从账号页绑定账号时（见第 5 步）。

4. 在 **Advanced protocol settings**（部分版本叫 _Protocol settings_）→ **Property mappings** 里选择：

    - `authentik default OpenID Mapping: openid`
    - `authentik default OpenID Mapping: profile`
    - 自定义的 **`wg-easy verified email`**——同时**移除** `authentik default OpenID Mapping: email`

其余保持默认。注意 sub mode（默认 `hashed_user_id`）：wg-easy 用令牌里的 `sub` 声明来绑定账号，所以用户绑定之后**不要**再改 sub mode——它会改变所有用户的 `sub`，绑定关系会无声地全部失效。

## 第 3 步 — 创建应用（Application）

1. 管理界面 → **Applications** → **Create**（如果是分开建的，就在这里把 Provider 关联到新应用）。
2. 填写：

    | 字段     | 值        |
    | -------- | --------- |
    | Name     | `wg-easy` |
    | Slug     | `wg-easy` |
    | Provider | `wg-easy` |

3. 可选：用 policy 或组限制谁能看到/使用这个应用——否则所有 Authentik 用户都能尝试登录 wg-easy（是否放行还取决于第 5 步的域名过滤和自动注册设置）。

**slug** 决定 issuer URL。slug 为 `wg-easy` 时是：

```
https://auth.example.com/application/o/wg-easy/
```

随时可以在 Provider 详情页核对（OpenID Configuration URL）。发现（discovery）返回的 issuer 必须与该 URL 完全一致——包括结尾的斜杠。

## 第 4 步 — 配置 wg-easy

两种等价方式，任选其一。

### 方式 A — 管理面板（免重启）

打开 **Admin Panel → OIDC**，填写：

| 字段          | 值                                                |
| ------------- | ------------------------------------------------- |
| Enabled       | 开                                                |
| Display Name  | `Authentik`（登录页按钮文案）                     |
| Issuer/Server | `https://auth.example.com/application/o/wg-easy/` |
| Client ID     | `<client-id>`                                     |
| Client Secret | `<client-secret>`                                 |

改动即时生效。面板会在 **Redirect URI** 处显示它期望的两个回调地址——和第 2 步核对一遍。留空的字段会回退到 `OAUTH_OIDC_*` 环境变量；密钥是只写的（存进 SQLite 数据库后不再回显）。完整字段说明见[管理面板的 OIDC 设置](./livewireguard.md#oidc-settings-in-the-admin-panel)。

### 方式 B — 环境变量

```yaml
environment:
    - OAUTH_PROVIDERS=oidc
    - OAUTH_OIDC_NAME=Authentik
    - OAUTH_OIDC_SERVER=https://auth.example.com/application/o/wg-easy/
    - OAUTH_OIDC_CLIENT_ID=<client-id>
    - OAUTH_OIDC_CLIENT_SECRET=<client-secret>
```

可选加固项：

| 环境变量                | 示例值        | 作用                             |
| ----------------------- | ------------- | -------------------------------- |
| `OAUTH_ALLOWED_DOMAINS` | `example.com` | 只允许这些域名后缀的邮箱登录     |
| `OAUTH_AUTO_REGISTER`   | `true`        | 首次登录时自动建号（见下方警告） |
| `OAUTH_AUTO_LAUNCH`     | `oidc`        | 打开登录页时直接跳转 Authentik   |
| `DISABLE_PASSWORD_AUTH` | `true`        | 完全关闭密码登录（见下方警告）   |

/// warning | 自动注册

`OAUTH_AUTO_REGISTER` 建出的账号带管理员权限（权限系统尚未实现）。只有当允许使用该 Authentik 应用的所有用户都可以管理 wg-easy 时才开启；否则请保持关闭，按下文手动绑定账号。

///

/// warning | 恢复访问

设置 `DISABLE_PASSWORD_AUTH=true` 之前，确保至少一个管理员账号已经通过 Authentik 成功登录过。如果最后一种登录方式都不可用，就只能重置配置才能重新进入。

///

## 第 5 步 — 绑定账号与首次登录

`OAUTH_AUTO_REGISTER=false`（默认值）时，推荐的上线步骤：

1. 用现有管理员账号登录面板。
2. 打开账号页 → **External Auth** → **Link**，在 Authentik 完成登录。这一步走的是 `.../link` 回调地址，把 wg-easy 账号和 Authentik 用户（`sub`）绑定起来。
3. 其他用户照此操作；如果合适也可以开启 `OAUTH_AUTO_REGISTER`。

匹配规则如下：

- OIDC 身份（`sub`）之前绑定过的，登录匹配到该账号。
- 否则按**已验证**的邮箱地址匹配同名账号，登录时自动绑定。
- 都匹配不上且未开启 `OAUTH_AUTO_REGISTER` 时，拒绝该身份。

验证：登出后，登录页会出现 **Authentik** 按钮，点击后无需输入密码即可回到面板。

## 第 6 步 — LiveWireGuard App 客户端（可选）

如果使用 LiveWireGuard App，再注册**第二个** Provider 作为公共客户端：

| 字段                      | 值                                                                                                                      |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Client type               | **Public**（无密钥；App 仅靠 PKCE 认证）                                                                                |
| Client ID                 | `livewireguard`（也可自定，见下）                                                                                       |
| Redirect/Post Logout URIs | `com.wuxichaorongtechnologycoltd.livewireguard:/oidc/callback`（自定义 scheme；Authentik 接受它作为回调地址）           |
| Property mappings         | `openid`、`profile`、自定义的 **`wg-easy verified email`**，以及 **`authentik default OpenID Mapping: offline_access`** |

注意：

- **`offline_access` 在这里是关键。** Authentik 只有在 Provider 挂了默认 `offline_access` 作用域映射时才会签发刷新令牌（refresh token）。没有刷新令牌，App 无法保持登录状态，每次同步都要重新登录。
- **自定义 email 映射在这里同样必要。** 账号还没按 `sub` 绑定过的用户，其设备同步时按 email 匹配——且要求 `email_verified` 为真。没有自定义映射时，这类设备会收到 `403 forbidden`。
- **Audience。** Authentik 把令牌的 `aud` 声明写成 client id，所以面板默认的 Audience（`livewireguard`）天然匹配。如果用了别的 client id，把它填到 **Admin Panel → General Settings → LiveWireGuard → Audience**。
- 把新的 client id 填到 **Admin Panel → OIDC → App Client ID**，这样首页展示的设置二维码会用这个客户端给 App 下发配置（公共客户端 ⇒ 二维码里不会包含任何密钥）。

App 侧的详细说明见 [LiveWireGuard 导入指南](./livewireguard.md)。

## 故障排查

| 现象                                 | 原因与处理                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| 登录报 `401 Email is not verified`   | 还挂着默认 email 映射。换成自定义的 `wg-easy verified email` 映射（第 1 步）。                                         |
| 登录报 `400 No email set`            | 完全没有挂 email 作用域映射。                                                                                          |
| `401 Email domain not allowed`       | `OAUTH_ALLOWED_DOMAINS` 不含该用户的邮箱域名。                                                                         |
| App 端点返回 `403 forbidden`         | 没有 wg-easy 账号匹配该令牌（见[用户匹配](./livewireguard.md#user-mapping)），或 email 声明未标记已验证。              |
| Authentik 报 `Redirect URI mismatch` | wg-easy 发出的回调地址没有逐字注册——和面板 **Redirect URI** 处显示的内容核对。                                         |
| 令牌端点返回 `invalid_client`        | 密钥错误，或 Provider 建成了 Public 类型（公共客户端不能用密钥认证）。                                                 |
| wg-easy 日志报 discovery/issuer 错误 | 配置的服务器地址与 discovery 的 issuer 不一致。使用 Provider 的 OpenID Configuration URL 中的精确 issuer，含结尾斜杠。 |
| App 无法保持登录                     | App 的 Provider 缺少 `offline_access` 作用域映射，Authentik 没有签发刷新令牌。                                         |
