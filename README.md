# dsh-opencode-go-catalog

DeepSeek Harness 插件：让 **OpenCode Go** 的模型清单跟随官方目录自动更新。

OpenCode Go 会不断上架新模型、下架旧模型（官方文档原话 "The list of models may change as we test and add new ones"）。而 DSH 的 pi-ai 路由只服务配置里列出的模型，且每个模型用哪种协议由 pi-ai **内置目录**决定——新模型它还不认识。

本插件把这件事闭环在 profile 内：

1. 读取公开目录 `GET https://opencode.ai/inference/go/v1/models`（无需密钥）；
2. 与 `llm-pi-ai` 行里 `opencode-go` 路由的 `models` 列表做 diff；
3. 新模型并入、退役模型移除、名称/上下文窗口/输出上限/输入模态刷新；
4. 通过 DSH 的 `configEditor.edit` 写回 profile 补丁并热重载——不重启、无需手动采纳。

单一路由、单一分组：路由固定 `api: openai-completions` + 官方 OpenAI 兼容 base URL，其余原生协议（anthropic / google / responses）由 OpenCode Console 翻译，因此不会把菜单拆成多个分组。

## 触发时机

| 触发 | 行为 |
|---|---|
| DSH 启动 | 插件加载后 `startupDelaySeconds`（默认 15s）自动同步一次 |
| 定时 | 每 `intervalMinutes`（默认 180）同步一次 |
| 手动 | `GET /x-opencode-go-catalog?refresh=1`（带浏览器会话鉴权） |

同步结果持久化在 profile 的 `cordis.patch.yml`，因此重启后即使离线也沿用上次清单。

## 安全兜底

- 目录接口失败、返回形状异常、条目数低于 `minimumCatalog`（默认 5）→ **绝不写入**；
- 只写入有差异的情况（幂等，实测第二次 `changed=false`）；
- `keep` 列表中的模型永不因下架而被移除；
- 任何一步异常只记录日志，向上返回 `{ ok:false, error }`，不破坏现有配置。

## 配置

```yaml
- id: opencode-go-catalog
  name: dsh-opencode-go-catalog
  config:
    entryId: llm-pi-ai            # 拥有 provider 表的 Loader 行
    provider: opencode-go         # 要同步的路由 id
    api: openai-completions       # 路由固定协议
    baseURL: https://opencode.ai/inference/go/openai/v1
    catalogUrl: https://opencode.ai/inference/go/v1/models
    intervalMinutes: 180
    startupDelaySeconds: 15
    prune: true
    keep: []                      # 永不移除的 model id
    minimumCatalog: 5
    obsoleteRoutes: [opencode-go-latest]   # 迁移清理：删除历史拆分路由
```

## 安装

```text
plugin_manager action=install_bundle target=<本仓库目录>
```

宿主侧只需要 `llm` 服务；`configEditor`、`webServer`、`connection` 均按需探测，缺失时插件仍可运行（只是没有手动路由）。

## 状态与诊断

```bash
curl -H "cookie: <已登录会话>" http://127.0.0.1:<port>/x-opencode-go-catalog
# -> { ok, last: { ok, trigger, catalog, total, added, removed, refreshed, error? }, lastWrite, settings }
```

`lastLastWrite.added/removed/refreshed` 给出最近一次写入的确切变化。

## 回退

- 停用/卸载 bundle，或删除 profile 补丁里的该行：自动同步停止，已写入的模型清单保留；
- 如需连模型清单一起还原，恢复你操作前的 profile 备份即可。

## 许可证

MIT
