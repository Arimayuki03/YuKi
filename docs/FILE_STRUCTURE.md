# YuKi 代码文件结构

> 生成方式：`Get-ChildItem -Recurse` + `git ls-files`（已过滤 `.venv`、`__pycache__`、`.test-runtime` 等运行时目录）。`vendor/`、`python-dist/`、`dist/`、`node_modules/` 为构建产物，不入库。

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
├── docs/                   项目文档（本文所在目录，共 9 份）
├── python-backend/         FastAPI 独立后端（CatVod + Kazumi 双引擎）
├── scripts/                构建、下载、验收与诊断脚本
├── src/                    Electron 主进程与渲染进程
├── tests/                  JS 单元测试（node --test）
├── vendor/                 第三方二进制（mpv/aria2c/ffmpeg/Anime4K/MiSans，不入库）
├── python-dist/            PyInstaller 产物（不入库）
├── dist/                   electron-builder 产物（不入库）
├── package.json            依赖与构建配置（appId com.yuki.app，productName YuKi）
├── eslint.config.js        ESLint 配置
├── ruff.toml               Ruff 配置
├── LICENSE                 GPLv3
├── README.md               项目入口
├── PROGRESS.md             当前开发状态（跨会话首要入口）
├── CHANGELOG.md            版本变更记录
├── CONTRIBUTING.md / CODE_OF_CONDUCT.md  社区文档
└── .gitignore              构建产物、运行时目录、网盘 Cookie 目录等
```

## `src/` — Electron

```
src/
├── main/                   主进程（26 文件）
│   ├── index.js            入口：窗口/托盘/Python 生命周期/mpv/aria2c/ffmpeg/解析窗口
│   │                       （含 writeMpvAssets：hints.lua/input.conf/menu.conf 注入、Anime4K 档位消费）
│   ├── async-session.js    AsyncSingleFlight / AsyncSerialQueue
│   ├── dl-dedupe.js        同源同集下载去重登记（站点|剧名|集名 稳定 key）
│   ├── hls-downloader.js   HLS 下载与广告过滤
│   ├── mpv-menu-conf.js    mpv 右键菜单中文定义（menu.conf 译制）
│   ├── mpv-player.js       mpv 进程管理与播放会话（原生队列/右键菜单/Anime4K 快捷键）
│   ├── parse-window.js     隐藏 BrowserWindow 真实流提取
│   ├── playlist-proxy.js   在线整季原生播放列表本地按需解析代理
│   └── ...                 downloads.js, cache.js, downloader.js 等
├── preload/
│   └── preload.js          渲染层 IPC 桥（yuki:*）
└── renderer/
    ├── index.html          单页应用壳
    ├── css/ui.css          全局样式
    ├── assets/             渲染层静态资源
    └── js/ (18 文件)       渲染层模块（均导出为 YUKI.*）
        ├── app.js          路由与视图调度
        ├── home.js         首页/分类/聚合搜索
        ├── detail.js       详情与播放入口
        ├── player.js       播放与续播
        ├── kazumi.js       Kazumi 规则管理与商店
        ├── panels.js       设置面板
        ├── common.js       工具与封面链
        └── ...             search.js, records.js, timeline.js 等
```

## `python-backend/` — FastAPI 后端

```
python-backend/
├── server.py               FastAPI 入口（/action, /kazumi/action, /cache, /proxy, /health）
├── config.py               配置管理
├── hoststate.py            宿主运行时状态（端口/缓存目录/代理地址，~/.video-pc 迁移兜底）
├── runner.py / app.py / trigger.py  CatVod 契约（恢复源码语义）
├── site_manager.py         站点管理
├── http_client.py          统一 HTTP 客户端
├── go_proxy.py             本地代理与端口管理（含夸克会话轮换捕获与保活探针）
├── jar_bridge.py / jar_spider.py / jar_patch.py  JAR 桥
├── js_spider.py            JS Spider 桥
├── pan*.py                 网盘（quark/uc 等）与 Cookie
├── play_contract.py / proxy_contract.py  播放/代理契约
├── requirements.txt        锁定依赖（26 包，pip-compile 生成）
├── requirements.in         顶层依赖声明
├── js-engine/              QuickJS 宿主
│   ├── quickjs_host.py     Context + 宿主 API（http/local/md5 等）
│   ├── host_bootstrap.js   全局注入
│   ├── spider-loader.js    Spider 加载协议
│   └── lib/cat.js          聚合库（cheerio/Crypto 等）
├── kazumi/                 Kazumi 规则引擎
│   ├── plugin_manager.py   规则 CRUD 与持久化（含 Bangumi 分页聚合、WebDAV 同步目录拼接）
│   ├── rule_engine.py      搜索/剧集编排
│   ├── xpath_strategy.py / api_strategy.py
│   ├── models.py / plugin.py / utils.py
│   └── assets/             内置规则（7sefun/DM84/enlie）
├── runtime/                运行时控制面
│   ├── config_snapshot.py  三层快照（下载/解析/运行）
│   ├── config_security.py  安全边界（体积/跳转/私网守卫）
│   ├── capability_router.py 站点能力路由
│   ├── supervisor.py / site_worker.py / supervised_runner.py
│   └── ...                 health.py, circuit.py 等
├── jar-runner/             JAR 运行器
│   ├── SpiderRunner.java   主入口
│   ├── stubs/              Android/CatVod 等存根（ ~200 文件）
│   ├── build.py / gen_stubs.py  构建脚本
│   └── runner.jar          构建产物（不入库）
├── spike/                  探针与 Spike 报告
└── tests/ (45+ 文件)
    ├── run_all.py          全量回归入口（40 阶段，串行）
    ├── smoke.py            冒烟测试
    ├── test_kazumi.py / test_phase3.py / test_config_snapshot.py 等
    ├── fixtures/           配置/媒体夹具（single.json 等确定性生成）
    └── offline_config_server.py  loopback 夹具服务器
```

## `scripts/` — 构建与验收

| 脚本 | 用途 |
|---|---|
| `download-binaries.js` | 下载 mpv/aria2c/ffmpeg/Anime4K/MiSans（`binaries.lock.json` 锁定） |
| `build-python.js` | PyInstaller 打包后端 → `python-dist/` |
| `check-js.js` | JS 语法门禁 |
| `binaries.lock.json` | 二进制完整性清单 |
| `acceptance-*.js` (10 个) | 真实界面验收（CDP，独立 userData 副本） |
| `diag-*.js` | 诊断脚本（分页/探针/真实环境） |

## `tests/` — JS 单元测试

`tests/js/*.test.js`（`node --test`，35 文件），覆盖观看统计、时间表、播放器（含原生队列记账/Anime4K）、播放列表代理、下载去重、右键菜单定义、设置、记录、封面链、下载等。

## 构建产物（不入库）

| 目录 | 内容 | 来源 |
|---|---|---|
| `vendor/` | mpv/aria2c/ffmpeg/Anime4K/MiSans | `scripts/download-binaries.js` |
| `python-dist/` | 后端 PyInstaller 产物 | `npm run build:py` |
| `dist/` | 安装包（NSIS exe 等） | `electron-builder` |
| `node_modules/` / `.venv/` | 依赖 | `npm install` / `pip install` |

## 文档

`docs/` 顶层 9 份 + `README.md` 索引，详见 [文档索引](README.md)：`ARCHITECTURE`、`KAZUMI`（合并）、`RUNTIME_ISSUES`、`TEST_REPORT`、`DEVELOPMENT_HISTORY`、`THIRD_PARTY`、`TVBOX_FONGMI_PARITY_TASKS`、`WEBDAV_SYNC_MERGE_DESIGN`。
