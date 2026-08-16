# 影视仓库兼容性测试报告

## 测试目标
验证软件能否成功导入用户提供的 21 个影视仓库地址并正常播放。

## 修改摘要
1. ✅ 前端统一 IDN 转换（中文域名 → punycode）
2. ✅ 支持 PNG 伪装配置（扩展魔数检测 JPEG + PNG）
3. ✅ 支持 gzip 压缩配置（自动解压）
4. ✅ header 传递采用合并策略（防 VIP 解析丢失）
5. ✅ 配置导入摘要提示网盘源数量

## 测试仓库列表

### 单仓（17 个）

| # | 名称 | 地址 | 预期结果 | 关键特性 |
|---|------|------|----------|----------|
| 1 | 饭太硬 | `http://www.饭太硬.net/tv` | ✅ 能导入 | 中文域名 + JPEG 伪装 |
| 2 | 肥猫 | `http://肥猫.net` | ✅ 能导入 | 中文域名 |
| 3 | 王小二放牛娃 | `http://tvbox.王二小放牛娃.top` | ✅ 能导入 | 中文域名 |
| 4 | 王小二新 | `https://9280.kstore.vip/newwex.json` | ✅ 能导入 | 标准 JSON |
| 5 | 哈基米 | `https://17264.kstore.space/哈基米.png` | ✅ 能导入 | PNG 伪装（新支持） |
| 6 | 南风 | `https://raw.githubusercontent.com/yoursmile66/TVBox/main/XC.json` | ✅ 能导入 | GitHub raw |
| 7 | 菜妮丝 | `https://tv.菜妮丝.top` | ✅ 能导入 | 中文域名 |
| 8 | HG | `https://api.hgyx.vip/hgyx.json` | ✅ 能导入 | 标准 JSON |
| 9 | 香雅情 | `https://raw.githubusercontent.com/xyq254245/xyqonlinerule/main/XYQTVBox.json` | ✅ 能导入 | GitHub raw |
| 10 | 小苹果 | `https://bitbucket.org/xduo/duoapi/raw/master/xpg.json` | ✅ 能导入 | Bitbucket |
| 11 | 欧歌 | `https://xn--anna-wn6lw489o.v.nxog.top/m/` | ✅ 能导入 | 标准 JSON |
| 12 | 驸马 | `http://fmys.top/fmys.json` | ✅ 能导入 | 标准 JSON |
| 13 | 分享 | `https://raw.githubusercontent.com/maoystv/6/main/000.json` | ✅ 能导入 | GitHub raw |
| 14 | 嗷呜 | `https://cnb.cool/aooooowuuuuu/FreeSpider/-/git/raw/main/config` | ✅ 能导入 | GitLab raw |
| 15 | L佬 | `https://android.lushunming.qzz.io/json/index.json` | ✅ 能导入 | 标准 JSON |
| 16 | 天神IY | `https://gitee.com/cpu-iy/iy/raw/master/%E5%A4%A9%E7%A5%9EIY.json` | ✅ 能导入 | Gitee（URL 编码路径） |
| 17 | 苹果CMS | `https://pastebin.com/raw/gtbKvnE1` | ✅ 能导入 | Pastebin |

### 多仓（4 个）

| # | 名称 | 地址 | 预期结果 | 关键特性 |
|---|------|------|----------|----------|
| 18 | 游魂多仓 | `https://www.iyouhun.com/tv/dc` | ✅ 能导入 | 多仓格式 |
| 19 | 老刘备多仓 | `https://raw.liucn.cc/box/m.json` | ✅ 能导入 | 多仓 + 注释 |
| 20 | 高天多仓 | `https://cdn.jsdelivr.net/gh/gaotianliuyun/gao@master/0707.json` | ✅ 能导入 | 多仓 + jsDelivr CDN |
| 21 | 小盒子多仓 | `http://xhztv.top/DC.txt` | ✅ 能导入 | 多仓 |

## 手动测试步骤

### 1. 基础导入测试
1. 启动应用：`npm start`
2. 打开设置页 → 源设置 → 载入视频源
3. 依次粘贴上述 21 个地址，点击「载入配置」
4. 确认每个地址都能成功导入（显示「已载入 X 个站点」）
5. 观察是否有「含 X 个网盘源」提示（针对含网盘源的配置）

### 2. 中文域名测试
**测试地址**：`http://www.饭太硬.net/tv`

**步骤**：
1. 粘贴到配置输入框
2. 点击载入
3. 打开浏览器开发者工具 → Network
4. 查看实际请求的 URL 是否为 `http://www.xn--ruqx1r65fwxb.net/tv`（punycode 编码）
5. 确认配置成功载入

**预期**：IDN 自动转换，后端收到 punycode 格式 URL

### 3. PNG 伪装测试
**测试地址**：`https://17264.kstore.space/哈基米.png`

**步骤**：
1. 粘贴到配置输入框
2. 点击载入
3. 确认配置成功载入（不报「配置不是有效的 JSON」错误）

**预期**：PNG 魔数检测生效，自动解析尾部 base64

### 4. 网盘源提示测试
**测试地址**：选择含网盘源的配置（如王小二新接口）

**步骤**：
1. 导入配置
2. 观察成功提示
3. 确认显示「含 X 个网盘源（播放需配置 Cookie，见设置→源设置→网盘账号）」

**预期**：用户看到友好提示，知道需要配置网盘 Cookie

### 5. 播放测试（端到端）
**前置条件**：已导入任意配置

**步骤**：
1. 首页选择任意站点
2. 搜索影片（如「斗罗大陆」）
3. 点击详情页 → 选择剧集播放
4. 确认能正常播放（mpv 窗口打开并开始播放）

**预期**：
- 直链源：直接播放
- 需解析源：VIP 解析成功后播放
- header 正确传递（无 403/referer 错误）

### 6. 网盘源播放测试
**前置条件**：已导入含网盘源的配置（如含 csp_Quark 的仓库）

**步骤**：
1. 未配置 Cookie 时：
   - 选择网盘源影片播放
   - 确认显示友好错误提示（「夸克网盘 Cookie 缺失或过期」）
2. 配置 Cookie 后：
   - 设置 → 源设置 → 网盘账号 → 夸克扫码登录
   - 重新播放网盘影片
   - 确认能正常播放

**预期**：Cookie 缺失时有友好提示，配置后能正常播放

## 自动化测试

### Python 单元测试
```bash
cd python-backend
../.venv/Scripts/python.exe tests/run_all.py
```

**覆盖**：
- `test_phase3.py`：配置加载、热更新
- `test_jar_phase.py`：jar 源加载
- `smoke.py`：后端健康检查

### JavaScript 语法检查
```bash
npm run test:js
```

**预期**：0 errors

### 完整测试套件
```bash
npm run test:all
```

**预期**：所有测试通过

## 已知限制

### 不支持的格式
1. **drpy 源**：PC 端无 drpy 运行时，会跳过（`config.py:516` 显式判定）
2. **需要 JRE 的 jar 源**：未安装 Java 时跳过，前端提示「需安装 JRE」

### 需要额外配置
1. **网盘源**：需要配置对应网盘 Cookie（夸克/UC/百度等）
2. **某些解析接口**：需要 VIP 账号或特定 token

## 回归测试检查清单

- [ ] 现有配置能否正常重新载入
- [ ] Kazumi 规则导入不受影响
- [ ] 直播源导入不受影响
- [ ] 首页站点列表正常显示
- [ ] 搜索功能正常
- [ ] 详情页播放正常
- [ ] mpv 播放器正常工作
- [ ] 历史记录正常保存
- [ ] 收藏功能正常

## 性能检查

- [ ] 配置导入速度未明显变慢（gzip 解压、PNG 检测开销可忽略）
- [ ] 多仓扫描时间合理（最多 12 个条目 × 15s 超时 = 3 分钟上限）
- [ ] 播放启动速度未受影响

## 提交信息
```
commit 7816695
feat(config): 增强影视仓兼容性

- 前端统一 IDN 转换（中文域名自动转 punycode）
- 支持 PNG 伪装配置（扩展魔数检测）
- 支持 gzip 压缩配置（自动解压）
- header 传递采用合并策略（VIP 解析不丢失源 header）
- 配置导入摘要提示网盘源数量
```

## 后续优化建议

1. **配置预检**：导入前先 HEAD 请求检测 Content-Type，提前识别直播源误导入
2. **drpy 运行时**：集成 drpy.js 运行时，支持 drpy 源（工作量大，需评估）
3. **配置历史详情**：历史源列表显示每条的站点数/类型分布
4. **网盘 Cookie 自动续期**：检测 Cookie 过期时间，提前提示或自动刷新
5. **批量导入**：支持一次粘贴多个配置地址（换行分隔）
6. **配置分享**：导出当前配置为 JSON，方便分享给其他用户
