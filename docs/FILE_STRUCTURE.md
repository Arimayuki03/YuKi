# YuKi 代码文件结构

> 生成方式：`Get-ChildItem -Recurse` + `git ls-files`（已过滤 `.venv`、`__pycache__`、`.test-runtime` 等运行时目录）。`vendor/`、`python-dist/`、`dist/`、`node_modules/` 为构建产物，不入库。
> 计数校准：2026-09-22。

## 顶层

```
YuKi/
├── .github/workflows/      CI 与发布流水线
│   ├── ci.yml              JS 单测 + Python 回归 + Lint
│   └── release.yml         tag v* → Windows NSIS → Draft Release
├── assets/                 应用图标与静态资源
├── build/                  electron-builder 额外资源
│   ├── icon.png            安装包图标
│   └── installer.nsh       NSIS 自定义安装页
├── docs/                   项目文档（本文所在目录，共 12 份 + README.md 索引）
├── python-backend/         FastAPI 独立后端（CatVod + Kazumi 双引擎）
├── scripts/                构建、下载、验收与诊断脚本
├── src/                    Electron 主进程与渲染进程
├── tests/                  JS 单元测试（node --test）
├── vendor/                 第三方二进制（mpv/aria2c/ffmpeg/Anime4K/MiSans/dex-tools/dexdeps/spider-runner.jar，不入库）
├── python-dist/            PyInstaller 产物（不入库）
├── dist/                   electron-builder 产物（不入库）
├── package.json            依赖与构建配置（appId com.yuki.app，productName YuKi）
├── pnpm-workspace.yaml     pnpm 工作区声明（实际安装用 npm，双锁文件并存）
├── package-lock.json / pnpm-lock.yaml  双锁文件
├── eslint.config.js        ESLint 配置
├── ruff.toml               Ruff 配置
├── LICENSE                 GPLv3
├── README.md               项目入口
├── PROGRESS.md             当前开发状态（跨会话首要入口）
├── DESIGN.md               视觉系统契约（色彩/排版/圆角/阴影/动效令牌与禁改清单）
├── CHANGELOG.md            版本变更记录
├── CONTRIBUTING.md / CODE_OF_CONDUCT.md  社区文档
└── .gitignore              构建产物、运行时目录、网盘 Cookie 目录等
```

## `src/` — Electron

```
src/
├── main/                   主进程（28 文件）
│   ├── index.js            入口：窗口/托盘/Python 生命周期/mpv/aria2c/ffmpeg/解析窗口
│   │                       （含 writeMpvAssets：hints.lua/input.conf/menu.conf 注入、Anime4K 档位消费）
│   ├── async-session.js    AsyncSingleFlight / AsyncSerialQueue
│   ├── dl-dedupe.js        同源同集下载去重登记（站点|剧名|集名 稳定 key）
│   ├── dl-layout.js        下载番剧子目录布局（路径段清洗 + <dlDir>/<番剧名>/<集名> 合成）
│   ├── dl-record.js        下载记录持久化（dl-records.json）
│   ├── downloader.js       aria2c 引擎封装
│   ├── hls-downloader.js   HLS 下载与广告过滤
│   ├── mpv-menu-conf.js    mpv 右键菜单中文定义（menu.conf 译制）
│   ├── mpv-player.js       mpv 进程管理与播放会话（原生队列/右键菜单/Anime4K 快捷键/弹幕 ASS 装载）
│   ├── parse-window.js     隐藏 BrowserWindow 真实流提取
│   ├── playlist-proxy.js   在线整季原生播放列表本地按需解析代理
│   ├── pan-source.js       网盘类源识别（PAN_SOURCE_RE：原生播放列表禁用/边下边播排除同源判定）
│   ├── pan-qr-window.js    夸克扫码登录窗口
│   ├── ext-watch.js        外部播放器观看会话追踪（墙钟计时长）
│   ├── ext-player / ffmpeg.js  ffmpeg 封装（ensureFfmpeg 按需下载）
│   ├── updater.js          应用内更新（electron-updater，RM-2）
│   ├── syncplay-client.js  SyncPlay 协议客户端（UI 未开放）
│   ├── dlna-caster.js      DLNA/SSDP 投屏（UI 未开放）
│   ├── push-server.js      局域网推送接收（手机推送 URL 交 mpv）
│   ├── system-proxy.js     系统代理设置
│   ├── settings.js         设置读写
│   ├── file-manager.js     本地文件管理 IPC
│   ├── media-probe.js      媒体探测
│   ├── misans.js           MiSans 内置字体装载（打包内置，无运行时下载）
│   ├── logger.js           日志
│   ├── app-icon.js / win-focus.js  托盘图标 / 窗口焦点
│   └── ...（共 28 个 .js）
├── preload/
│   └── preload.js          渲染层 IPC 桥（yuki:*）
└── renderer/
    ├── index.html          单页应用壳
    ├── css/ui.css          全局样式
    ├── assets/             渲染层静态资源
    └── js/ (19 文件)       渲染层模块（均导出为 YUKI.*）
        ├── app.js          路由与视图调度
        ├── home.js         首页/分类/聚合搜索
        ├── detail.js       详情与播放入口
        ├── player.js       播放与续播
        ├── kazumi.js       Kazumi 规则管理与商店
        ├── bangumi-search.js  Bangumi 搜索页签
        ├── panels.js       设置面板
        ├── popular.js      推荐页
        ├── about.js / ui-state.js  关于页 / UI 状态
        ├── common.js       工具与封面链
        └── ...             search.js, records.js, timeline.js, live.js 等
```

## `python-backend/` — FastAPI 后端

```
python-backend/
├── server.py               FastAPI 入口（/action, /kazumi/action, /cache, /proxy, /danmaku, /search/*, /health）
├── config.py               配置管理
├── cache_store.py          通用内存+文件两级缓存存储
├── mem_cache.py            会话级 TTL 内存缓存（0.2.5 提速）
├── hoststate.py            宿主运行时状态（端口/缓存目录/代理地址，~/.video-pc 迁移兜底）
├── runner.py / app.py / trigger.py  CatVod 契约（恢复源码语义）
├── site_manager.py         站点管理
├── http_client.py          统一 HTTP 客户端
├── go_proxy.py             本地代理与端口管理（含夸克会话轮换捕获与保活探针）
├── proxy_gateway.py        统一 /proxy 网关（N3.5）
├── jar_bridge.py / jar_spider.py / jar_patch.py  JAR 桥
├── java_probe.py           JVM 探测
├── js_spider.py            JS Spider 桥
├── cms_spider.py           苹果 CMS JSON/XML 源
├── compat.py               Python 3.14 兼容层（SourceFileLoader.load_module）
├── pan_cookies.py / pan_login.py  网盘 Cookie 与扫码登录
├── pan/                    网盘 Provider 包（quark 等）
├── play_contract.py / proxy_contract.py  播放/代理契约
├── play_cache.py           playerContent 解析结果持久缓存（RM-4：<cache>/play-cache/，TTL 2h）
├── spiders/ / base/        CatVod 基类与内置 Spider
├── requirements.txt        锁定依赖（31 包，pip-compile 生成）
├── requirements.in         顶层依赖声明
├── requirements-build.txt  PyInstaller 工具链锁
├── js-engine/              QuickJS 宿主
│   ├── quickjs_host.py     Context + 宿主 API（http/local/md5 等）
│   ├── host_bootstrap.js   全局注入
│   ├── spider-loader.js    Spider 加载协议
│   ├── esm_transform.py / module_resolver.py  ESM 支持
│   └── lib/cat.js          聚合库（cheerio/Crypto 等）
├── kazumi/                 Kazumi 规则引擎
│   ├── plugin_manager.py   规则 CRUD 与持久化（含规则商店、Bangumi/弹幕对接、WebDAV 同步目录拼接）
│   ├── rule_engine.py      搜索/剧集编排
│   ├── xpath_strategy.py / api_strategy.py
│   ├── models.py / plugin.py / utils.py / cookie_jar.py
│   └── assets/             内置规则（7sefun/DM84/enlie）
├── runtime/                运行时控制面
│   ├── config_snapshot.py  三层快照（下载/解析/运行）
│   ├── config_security.py  安全边界（体积/跳转/私网守卫）
│   ├── capability_router.py 站点能力路由
│   ├── supervisor.py / site_worker.py / supervised_runner.py
│   └── ...                 health.py, circuit.py 等
├── jar-runner/             JAR 运行器
│   ├── SpiderRunner.java   主入口
│   ├── stubs/              Android/CatVod 等存根（~270 文件）
│   ├── build.py / gen_stubs.py  构建脚本
│   └── runner.jar          构建产物（复制到 vendor/spider-runner.jar）
├── spike/                  探针与 Spike 报告
└── tests/ (58 个 .py)
    ├── run_all.py          全量回归入口（56 阶段，串行）
    ├── smoke.py            冒烟测试
    ├── test_kazumi.py / test_phase3.py / test_config_snapshot.py 等（55 个 test_*.py）
    ├── test_play_cache.py  解析结果持久缓存单测（RM-4）
    ├── fixtures/           配置/媒体夹具（single.json 等确定性生成）
    └── offline_config_server.py  loopback 夹具服务器
```

## `scripts/` — 构建与验收

| 脚本 | 用途 |
|---|---|
| `download-binaries.js` | 下载 mpv/aria2c/ffmpeg/Anime4K/MiSans（`binaries.lock.json` 锁定；postinstall 仅 Anime4K，构建前 MiSans） |
| `build-python.js` | PyInstaller 打包后端 → `python-dist/` |
| `after-pack.js` | electron-builder afterPack 钩子：剔除系统自带冗余 DLL（Electron d3dcompiler_47.dll 与后端捆绑 UCRT，杀软误报源；`YUKI_KEEP_SYSTEM_DLLS=1` 保留） |
| `check-js.js` | JS 语法门禁 |
| `run-jsunit.js` | `node --test` 跨平台封装（test:jsunit 入口） |
| `binaries.lock.json` | 二进制完整性清单 |
| `acceptance-*.js` (11 个) | 真实界面验收（CDP，独立 userData 副本） |
| `diag-*.js` / `verify-*.js` | 诊断与验证脚本（分页/探针/真实环境） |
| `make-tray-icons.ps1` | 托盘图标生成（icons:tray） |

## `tests/` — JS 单元测试

`tests/js/*.test.js`（`node --test`，55 文件 / 540 用例），覆盖观看统计、时间表、播放器（含原生队列记账/Anime4K/弹幕）、播放列表代理、网盘源播放策略（pan-source-playlist）、下载去重与番剧目录、右键菜单定义、设置、记录、封面链、下载、打包钩子（after-pack）、更新控制器（updater-controller）等。

## 构建产物（不入库）

| 目录 | 内容 | 来源 |
|---|---|---|
| `vendor/` | mpv/aria2c/ffmpeg/Anime4K/MiSans（download-binaries.js）+ dex-tools/dexdeps（随源码树）+ spider-runner.jar（自建产物） | 混合来源，见 [THIRD_PARTY.md](THIRD_PARTY.md) |
| `python-dist/` | 后端 PyInstaller 产物 | `npm run build:py` |
| `dist/` | 安装包（NSIS exe 等） | `electron-builder` |
| `node_modules/` / `.venv/` | 依赖 | `npm install` / `pip install` |

## 文档

`docs/` 顶层 12 份 + `README.md` 索引，详见 [文档索引](README.md)：`GUIDE`（用户使用指南）、`ARCHITECTURE`、`KAZUMI`（合并）、`RUNTIME_ISSUES`、`TEST_REPORT`、`DEVELOPMENT_HISTORY`、`THIRD_PARTY`、`TVBOX_FONGMI_PARITY_TASKS`、`WEBDAV_SYNC_MERGE_DESIGN`、`ROADMAP`。
