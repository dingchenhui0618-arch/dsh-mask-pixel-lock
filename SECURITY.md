# 安全模型 / Security model

This document describes what **dsh-mask-pixel-lock** trusts, what it reads and writes, and
where the boundary sits. It was written from the implementation (`src/host.js`,
`src/core/verify.js`, `src/core/png.js`, `src/core/compare.js`, `src/core/proof.js`,
`src/core/report.js`, `bin/mask-pixel-lock.mjs`).
**If this document and the code disagree, the code is right and this document is a bug.**

> 一句话：这是一个**本地像素证明器**，信任边界画在「它能读到的文件系统」上。给它三张 PNG
> 路径和一个输出目录，它就读、算、写报告；它不联网、不开端口、不删文件，也不验证「这张图
> 是谁生成的」。

## 信任边界

插件跑在 DSH 宿主进程里，两个表面共用同一个同步核心 `verifyFiles()`：

| 表面 | 谁在用 | 鉴权 |
| --- | --- | --- |
| `mask_pixel_lock_verify` 工具（`src/host.js` 的 `tools.register`） | 当前会话里的 agent | 没有插件自己的 token |
| `/dsh-mask-pixel-lock` 路由（`ctx.webServer.register`，`kind: 'prefix'`） | 本机「像素锁」面板 / 浏览器 | **插件不鉴权**，只依赖 DSH web server 的访问控制 |

它**不监听自己的端口**，HTTP 面挂在 DSH 已有的 web server 上。路由的 GET 只服务
**本次进程内记住的记录**（`records`，最多 40 条），媒体按记录 id 查，不接受任意路径：

- `GET /dsh-mask-pixel-lock/state`
- `GET /dsh-mask-pixel-lock/heatmap/<id>` / `report/<id>` / `json/<id>`
- `POST /dsh-mask-pixel-lock/verify`（完整校验并写报告）
- `POST /dsh-mask-pixel-lock/clear`（只清空内存里的记录，**不删磁盘文件**）

读哪些文件：只读调用方给的三张 PNG——`original`、`generated`、`mask`。全部用
`node:fs` 同步读（`src/core/verify.js` 的 `readPng`），没有走 `ctx.fs`。

写哪些文件（`src/core/verify.js` 的 `writeOutputs` / `writeReportFiles`）：

- `heatmap.png`、`report.json`、`report.html` 三个文件；
- 默认输出目录在**生成图旁边**新建 `mask-pixel-lock-<UTC 时间>`；`outputDir` 可指向任意
  目录，已存在时自动加 `-2`、`-3`（`resolveOutputDir`，`mkdirSync(..., { recursive: true })`）；
- 报告 HTML 把三张输入图各自不超过 4 MiB 的字节以 base64 内嵌；更大的图只写路径。

## 不可信输入

- **三张 PNG 的字节**。这是本插件最主要的不受信输入：解码器 `src/core/png.js` 自己实现，
  按 PNG 规范校验签名、每个 chunk 的 CRC、IHDR、PLTE 边界、扫描线过滤器、截断与 IEND；
  声明尺寸上限 64 兆像素，单文件上限 128 MB（`MAX_PIXELS` / `MAX_FILE_BYTES`）。不支持的
  布局按名字拒绝，不猜着解。
- **路径与策略参数**：`original` / `generated` / `mask` / `outputDir` 由调用方给，绝对路径
  或相对宿主进程 cwd；`maskMode` 只认 `edit` / `lock`，`maskThreshold`、`tolerance` 必须是
  0..255 整数，否则抛 `InputError`（`verifyFiles` 的 `integerInRange`）。
- **HTTP 请求体**：`POST /verify` 的 JSON，超过 2 MiB 直接 `req.destroy()`，解析失败当 `{}`。
- **蒙版图本身**：它决定哪些像素受保护。蒙版全白/全透明会导致「没有受保护像素」，
  报告返回 `EMPTY` 并明确警告——**`EMPTY` 不等于 PASS**（`src/core/compare.js`）。
- **`label`**：最多 120 字符，写进报告、经过 `escapeHtml`（`src/core/report.js`）。

## 鉴权 / 权限现状（照实写）

- **工具没有 token**：任何能调用 `mask_pixel_lock_verify` 的 agent 都能读任意三张 PNG、
  往任意可写目录写报告。这是本地校验工具的预期权限，不是沙箱。
- **HTTP 路由没有自己的鉴权**：`/state`、`/heatmap`、`/report`、`/json`、`/verify`、`/clear`
  都不检查 header、token、Origin，也没有 CSRF 校验。`POST /verify` 会**读文件并写文件**；
  `POST /clear` 只清内存。能访问 DSH web server 的本机页面就能触发一次校验。
- **媒体接口不是文件浏览器**：`heatmap/report/json` 只能取内存记录里那几条路径，路径由本
  插件在 verify 时写入，请求方不能指定。但注意：记录里保存的是**相对 cwd 的显示路径**，
  服务时再用 `resolve(process.cwd(), path)` 还原（`src/host.js` 的 `absolutePath`）；如果
  verify 之后宿主进程的 cwd 变了，链接可能 404，理论上也可能落到另一个同名相对路径上。

## 数据与副作用

- **不联网、不调模型、不上传图片**：`src/` 里没有 `fetch` / `http` / `https`。
- **只写不删**：没有 `unlink` / `rm`；`clear` 清空的是内存记录，磁盘上的报告目录会留着，
  需要你自己清理。
- **同步执行**：解码、逐像素比较、生成热力图、算哈希全部在 `verifyFiles()` 里同步完成
  （代码注释明确写了这是为了让证据绑定同一份快照）。图片大时它会占住宿主的事件循环。
- **证明的语义**（`src/core/proof.js`）：文件 SHA-256 证明「字节没换」；受保护像素摘要证明
  「蒙版外内容没变」（与 PNG 编码器无关）；`proofDigest` 把策略、文件哈希和两个像素摘要绑在
  一起。**它不是数字签名**——能改写报告的人也能重算摘要。
- **不收集遥测**，没有账号信息；面板记录只在内存，重启即失。

## 已知限制

1. **路径不受限**：输入与输出目录都可以是任意绝对路径，没有符号链接检查；`readPng` 用
   `statSync` + `readFileSync`，会跟随符号链接。它能读/写的就是宿主进程能读/写的。
2. **同步阻塞**：一次校验在宿主线程上跑完，128 MB 输入或 64 MP 图像会明显卡住会话；
   没有队列、没有超时、没有限速。
3. **解压输出没有额外上限**：`inflateSync` 只受 Node zlib 自身默认行为约束，插件只限制了
   声明尺寸（64 MP）与压缩文件大小（128 MB）。一个声明尺寸合法但 IDAT 超量膨胀的畸形文件
   仍可能造成较大的瞬时内存分配。
4. **16 位样本取高 8 位**参与比较（`sampleMsb`），这是有意的、写进 README 的取舍；ICC /
   EXIF 方向不参与换算，所以字节不同但视觉相同的图会判 FAIL。
5. **证明是本地完整性，不是签名**：报告、`proofDigest` 都可以被本机用户改写；要抗篡改，
   需要把 `proofDigest` 记到外部系统。
6. **`tolerance > 0` 允许「宽容 PASS」**：像素摘要不相等时仍可能 PASS，报告会写警告并保留
   `exactChangedPixels`。严格验收请用 `tolerance: 0`。
7. **媒体链接依赖进程 cwd**：见上文，cwd 变化后旧记录的链接可能失效。
8. **内存记录上限 40 条**：更早的记录不再能通过路由访问（磁盘文件仍在）。
9. **不做内容判断**：「改得对不对」「主体自不自然」不在范围内，它只回答蒙版外有没有变。

## 明确不算漏洞的

- 报告 HTML 内嵌了完整输入图——这是「断网可打开、可归档」的设计，超过 4 MiB 时自动不内嵌。
- 能访问路由的人能看到已生成的报告和本地路径——这是本地面板的设计，见「已知限制」1。
- `EMPTY` 不算 PASS——设计如此，避免「没有可保护像素」被当成通过。
- 尺寸不同返回 `FAIL / dimensions-differ` 且 `proof: null`——设计如此，不假装证明成功。
- 蒙版画错导致结论不符合预期——输入决定结论；报告会显示策略与受保护像素数，便于复核。
- 16 位精度截断、色彩空间差异判为不同——声明过的字节级语义。
- 本机用户能改写报告与摘要——本地证明不是签名。

## 报告漏洞

用 GitHub 的私密渠道：
<https://github.com/dingchenhui0618-arch/dsh-mask-pixel-lock/security/advisories/new>

个人项目，**不承诺响应时限**；会读、会修，修完写进 `CHANGELOG.md` 并说明影响范围。请不要把
仍在生效的问题先发到公开 issue。

## 支持范围

只维护**最新一版**（`main` 上的 `0.1.x`）。这个包**尚未发布到 npm**，通过 GitHub 源或本地
目录安装；升级到最新 `main` 即可，更早的提交不再单独回补。
