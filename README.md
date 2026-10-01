# MeetFair · 聚点

[![CI](https://github.com/quyiting/meetfair-wechat-miniapp/actions/workflows/ci.yml/badge.svg)](https://github.com/quyiting/meetfair-wechat-miniapp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

一个原生微信小程序：收集 2–8 位参与者的位置和偏好，推荐整体通勤更公平的聚会地点与时间。

> 当前项目处于 MVP 阶段，适合学习、试用和二次开发；上线前请完成隐私合规、数据库权限和真机验收。

## 功能

- 支持 2–8 人填写位置、交通方式、预算和偏好。
- 支持当前位置、手动选点和地址近似定位。
- 按“最公平”“总路程最短”“最照顾最远的人”三种目标生成建议。
- 结合腾讯位置服务与高德 Web 服务获取候选地点和真实路线；外部服务异常时降级为估算结果。
- 根据成员时间段交集给出聚会时间建议。
- 成员可修改自己的位置和出行信息；创建者可确认最终地点与时间。
- 通过 6 位房间码共享房间，并使用云函数同步成员、候选地点和投票。
- 预览加入者位置后再认领身份，支持离开房间、删除房间和过期房间清理。

## 推荐逻辑

推荐会综合参与者到候选地点的路线时间，并按所选目标排序：

- **最公平**：降低成员之间的通勤时间差异。
- **总路程最短**：降低所有成员通勤时间之和。
- **照顾最远的人**：优先降低最长单人通勤时间。

交通方式、预算和地点偏好会参与筛选或评分。路线接口不可用时，页面会明确标记估算状态，不会把直线距离伪装为真实路线。

成员变化后，旧地点与路线会标为待更新，由创建者刷新。地点列表会说明首选与第二名的主要通勤差异及真实路线覆盖人数。每位成员可为创建者选定的日期填写最多 5 段可用时间；建议按 1 小时聚会时长计算，当天会预留预计通勤时间。创建者确定新时间后，地点营业状态和路线需重新查询。

## 快速开始

### 前置条件

- [微信开发者工具](https://developers.weixin.qq.com/miniprogram/dev/devtools/download.html)
- 已开通的微信云开发环境
- Node.js 20 或更高版本
- 腾讯位置服务或高德开放平台的 Web 服务密钥

### 本地运行

```bash
git clone https://github.com/quyiting/meetfair-wechat-miniapp.git
cd meetfair-wechat-miniapp
npm test
```

随后用微信开发者工具导入项目，并完成以下替换：

1. 将 `project.config.json` 中的 `appid` 替换为你自己的小程序 AppID。
2. 将 `miniprogram/app.js` 和 `cloudbaserc.json` 中的云环境 ID 替换为你自己的环境。
3. 在云端配置地图服务密钥，不要把密钥写入小程序端或提交到 Git。

AppID 和云环境 ID 是项目标识，不等同于服务端密钥；公开仓库仍建议使用自己的标识，避免误部署到他人的环境。

## 云开发部署

在微信开发者工具中上传并部署以下云函数：

- `roomService`：房间、成员、投票和身份操作。
- `venueService`：地点搜索、逆地址解析和路线查询。
- `cleanupExpiredRooms`：清理过期房间；需在云端按需配置定时触发器。

更新小程序代码后，需重新部署受影响的云函数并重新编译小程序。若云端不可用，创建的房间会明确显示为本机模式，可在恢复后重试同步。

为 `venueService` 配置所选地图服务的环境变量：

| 地图服务 | 必填 | 使用签名校验时 |
| --- | --- | --- |
| 高德 | `AMAP_KEY` | `AMAP_SK` |
| 腾讯位置服务 | `QQ_MAP_KEY` | `QQ_MAP_SK` |

数据库权限建议：

- `rooms` 禁止小程序端直接读写，所有操作通过 `roomService` 完成。
- `roomSignals` 只允许已登录用户读取自己的信号记录，禁止小程序端直接写入。可使用安全规则 `{"read": "doc.openid == auth.openid", "write": false}`。

`venueService` 对相同区域、类别和聚会时间的地点搜索使用单个云函数实例内 5 分钟缓存；实例更换后缓存不会保留。云函数日志仅记录操作、服务商、耗时、结果数量和缓存命中次数，不记录坐标或地图密钥。

## 隐私与数据

- 房间位置仅用于本次推荐；加入者认领身份前只能看到模糊位置预览。
- 房间数据会记录创建与过期时间，可由房主删除，也可通过清理云函数删除过期数据。
- 请勿提交真实地图密钥、OpenID、房间码、精确住址或生产数据。
- 本项目没有替代你在微信公众平台完成的隐私声明、用户授权和数据保留策略配置。

## 项目结构

```text
.
├── miniprogram/                 # 小程序页面、组件、样式和本地推荐逻辑
├── cloudfunctions/
│   ├── roomService/             # 房间协作与身份操作
│   ├── venueService/            # 地点与路线服务
│   └── cleanupExpiredRooms/      # 过期房间清理
├── tests/                       # Node.js 回归测试
├── cloudbaserc.json             # 云开发环境配置
└── project.config.json          # 微信开发者工具项目配置
```

## 开发与验证

```bash
npm test
find miniprogram cloudfunctions tests -name '*.js' -print0 | xargs -0 -n1 node --check
```

自动化测试覆盖推荐、时间匹配、房间操作、权限、路线服务和过期清理等核心逻辑。它不能代替微信开发者工具编译、云函数部署和真机网络/授权验收。

## 当前限制

- 云端通过私人信号文档触发页面拉取；订阅不可用时可下拉手动同步。
- 只有创建者可以刷新全员候选地点。创建者不在线时，其他成员会看到待更新提示。
- 真实路线请求只覆盖排名靠前的候选地点，其余结果可能使用估算值。
- 地图服务配额、签名、域名白名单和网络状态会影响地点与路线结果。
- 尚未提供完整的无障碍、国际化和自动化真机测试。

## 参与贡献

欢迎提交问题和改进。开始前请阅读 [CONTRIBUTING.md](CONTRIBUTING.md)；安全问题请按 [SECURITY.md](SECURITY.md) 私下报告。

## 开源协议

本项目基于 [MIT License](LICENSE) 开源。
