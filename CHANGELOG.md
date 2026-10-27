# Changelog

## [Unreleased]

### 文档与工程

- 新增 `SECURITY.md`：信任边界、不可信输入、鉴权现状、已知限制与漏洞报告渠道。
- CI（`.github/workflows/ci.yml`）已覆盖 build、`lib/` 一致性、单测与打包 dry-run，这里只做核对。
- README 顶部加 CI / license badge 与 star 引导。

## 0.1.0 — 2026-10-22

首个版本。

- `mask_pixel_lock_verify` 工具：原图 + 生成图 + 蒙版三张 PNG，逐像素比较受保护区。
- `edit` / `lock` 两种蒙版语义；墨量 = 亮度 × alpha / 255；阈值可调。
- PASS / FAIL / EMPTY 三态；`EMPTY` 明确区别于 PASS。
- 容差、忽略 alpha、差异直方图、最大/平均通道差、差异包围盒、最大差异像素样本。
- 差异热力图：受保护区未变为近黑，可编辑区为暗蓝灰，变化像素琥珀 → 红。
- SHA-256 文件哈希 + 规范化受保护像素摘要 + 绑定策略的证明摘要。
- 自包含中文 HTML 报告与机器可读 `report.json`（schema `dsh-mask-pixel-lock/report@1`）。
- 会话视图「像素锁」面板：运行校验、查看热力图与最近记录。
- 零依赖 CLI，退出码 0/1/2/3。
- 零依赖 PNG 解码：颜色类型 0/2/3/4/6，位深 1/2/4/8/16，五种过滤器，Adam7，`tRNS`。
- 78 个测试：PNG 兼容性、比较语义、端到端报告、host 工具/路由、client 注册/卸载、CLI、打包清单。
