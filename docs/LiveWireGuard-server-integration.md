# LiveWireGuard 服务端对接文档

按下面的接口在你的服务器上实现后，LiveWireGuard 就能通过 OIDC 登录自动获取 VPN 配置。示例已按你当前填写的信息生成，可直接复制。

## 总体流程

用户用 OIDC 登录你的身份提供方（授权码 + PKCE）；App 拿到令牌后，把令牌放在请求头里，向用户填写的 URL 发一个 GET 请求来获取节点信息。URL 必须使用 HTTPS，并且必须是完整的接口地址（含路径），App 不会追加任何路径。服务端必须校验所用令牌的签名、iss、aud 和 exp，具体见下方「登录令牌的传递」。


## 获取节点信息（必须）

`GET {URL}`

{URL} 指用户在 App 里填写的完整接口地址（含路径），App 会原样请求，不会追加任何路径，下面的示例已用你填写的 URL。设备标识通过请求头传递：服务端可以用它区分设备，也可以完全忽略，只按令牌里的用户返回配置。

**请求**

```
GET https://vpn.example.com/api/livewireguard/config
Authorization: Bearer <access_token>
X-Id-Token: <id_token>
X-Device-Id: 5E7C0A4B-1D2F-4B8A-9C3E-7F6A5B4C3D2E
X-Public-Key: <base64 WireGuard public key>
If-None-Match: "rev-17"
```

**请求头说明**

```
Authorization   必填：Bearer 加访问令牌（access_token）
X-Id-Token      ID 令牌（id_token，JWT）。IdP 签发了 ID 令牌且未过期时才发送，否则没有这个头
X-Device-Id     App 为每个账号随机生成的 UUID。需要按设备区分时使用，否则忽略；请以（用户, X-Device-Id）为键，不要全局唯一
X-Public-Key    本机生成的 WireGuard 公钥（Base64）。需要为该设备添加对端时使用，否则忽略
If-None-Match   上次 200 响应的 ETag；仅在上次响应带了 ETag 时发送
User-Agent      LiveWireGuard/<版本> (macos | ios | ipados)
```


## 登录令牌的传递

App 不让用户选择发送哪种令牌，而是把两种令牌都放在请求头里，让不同的 IdP 和服务端都能直接使用：Authorization: Bearer <access_token> 始终发送；X-Id-Token: <id_token> 在 IdP 签发了 ID 令牌且未过期时发送。服务端任选其一校验即可：建议优先校验访问令牌（aud 应包含你自己服务的标识）；如果你的 IdP 签发的是不透明的访问令牌，可以改为校验 ID 令牌（JWT，aud 为 Client ID）。刷新令牌永远不会发送。令牌可能包含用户的邮箱或姓名，请只在 HTTPS 下使用，且不要写入日志。


## 响应（200 / 304）

支持 If-None-Match：配置没变时返回 304，无响应体。configs 里新增或删除条目，App 会相应增删本地隧道；configs 至少要有一条，空数组会被当作服务端故障，不会据此删除本地隧道。配置里不含 PrivateKey 时，App 使用本机生成的私钥（公钥通过 X-Public-Key 提供）；含 PrivateKey 时使用服务端给出的私钥。字段见下方「字段说明」。

**响应 200**

```
HTTP/1.1 200 OK
Content-Type: application/json
ETag: "rev-17"

{
  "configs" : [
    {
      "expires_at" : "2026-11-15T09:53:17Z",
      "name" : "Office",
      "refresh_after" : "2026-10-17T09:53:17Z",
      "remote_id" : "office",
      "revision" : "17",
      "wg_quick" : "[Interface]\nAddress = 10.8.0.5/32\nDNS = 10.8.0.1\n\n[Peer]\nPublicKey = <server public key>\nAllowedIPs = 10.8.0.0/24\nEndpoint = vpn.example.com:51820\nPersistentKeepalive = 25"
    }
  ],
  "policy" : {
    "allow_export" : false,
    "offline_grace_seconds" : 0
  }
}
```

**响应 304（配置没变，无响应体）**

```
HTTP/1.1 304 Not Modified
ETag: "rev-17"
```

**字段说明**

```
configs                   array             必填，至少一条
  remote_id               string            必填，在 configs 内唯一
  name                    string            可选，隧道显示名；省略时用 remote_id
  wg_quick                string            必填，标准 wg-quick 文本，需含 [Interface] 和至少一个 [Peer]
  revision                string | number   可选，配置版本号，App 仅用于展示
  expires_at              string            可选，ISO 8601；到期后 App 拒绝连接
  refresh_after           string            可选，ISO 8601；建议再次同步的时间
policy                    object            可选
  allow_export            bool              可选，默认 false；是否允许用户导出、分享配置
  offline_grace_seconds   int               可选，默认 0；登录失效后仍可使用现有配置的秒数
```


## 错误响应约定

错误时返回 JSON 错误体，App 按状态码处理：

**错误响应体**

```
{
  "error" : "forbidden",
  "error_description" : "account disabled"
}
```

**状态码处理**

```
401  令牌无效或过期：App 刷新令牌重试一次，仍失败则提示用户重新登录
403 / 410  账号被禁用或设备被撤销：App 标记为已撤销并禁止连接
404  地址写错或路径不存在：App 显示错误并稍后重试，不会判为被撤销
409  设备数量达到上限（服务端按设备限制时返回）：App 显示错误并按退避稍后重试
429  请求过于频繁：按 Retry-After 退避重试
5xx  服务端故障：沿用本地缓存配置，稍后重试
```


## 身份提供方（IdP）侧设置

请在 IdP 中把此客户端登记为公共客户端（令牌端点认证方式为 none），启用授权码 + PKCE（S256），并把下面的回调地址加入允许的重定向 URI。需要长期登录请授予 offline_access。如果该客户端在 IdP 中是机密客户端，请在向导里填写 Client Secret。

**回调地址（Redirect URI）**

```
com.wuxichaorongtechnologycoltd.livewireguard:/oidc/callback
```

**Client ID**

```
livewireguard
```

**Scopes**

```
openid profile email offline_access
```

