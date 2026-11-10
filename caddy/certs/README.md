# 已有证书

`.env` 中设置 `CADDY_TLS_MODE=file` 时，Caddy 使用本目录下的证书和私钥，不再自动申请证书。

本目录除这个 README 外的所有文件都被 `.gitignore` 和 `caddy/.dockerignore` 忽略，私钥不会被提交，也不会进入镜像。

## 放哪些文件

| 文件 | 默认文件名 | 说明 |
| ---- | ---------- | ---- |
| 证书 | `cert.pem` | PEM 格式的完整证书链：服务器证书在前，中间证书在后 |
| 私钥 | `key.pem`  | PEM 格式，不能有密码 |

文件名不同时，不用改名，在 `.env` 中设置 `CADDY_TLS_CERT_FILE`、`CADDY_TLS_KEY_FILE` 即可。

- 腾讯云 SSL 证书：下载 Nginx 格式，用 `<域名>_bundle.crt` 和 `<域名>.key`
- 阿里云 SSL 证书：下载 Nginx 格式，用 `<名称>.pem` 和 `<名称>.key`
- 通配符证书（如 `*.verycloud.cn`）可以直接用于 `vrh.verycloud.cn`

## 权限

Caddy 容器去掉了所有特权（`cap_drop: ALL`），只能读取属主是 root 的文件：

```shell
sudo chown root:root caddy/certs/*
sudo chmod 644 caddy/certs/cert.pem
sudo chmod 600 caddy/certs/key.pem
```

## 检查

```shell
# 域名和到期时间
openssl x509 -in caddy/certs/cert.pem -noout -subject -enddate -ext subjectAltName
# 证书和私钥是否配对（两行输出应完全相同）
openssl x509 -in caddy/certs/cert.pem -noout -pubkey | openssl sha256
openssl pkey -in caddy/certs/key.pem -pubout | openssl sha256
```

## 续期

这种模式不会自动续期。到期前把新证书覆盖到本目录，然后执行 `docker restart wg-easy-caddy`。
