/**
 * mpv-menu-conf.js — 内置播放器右键菜单的中文定义（menu.conf）
 *
 * mpv 官方刻意不做界面本地化（mpv-player/mpv#13828），右键上下文菜单的文字由
 * select.lua 从 menu.conf 读取：配置目录存在该文件则用之，否则回退内置英文版；
 * 也可用 `--script-opt=select-menu_conf_path=<路径>` 指定任意路径（--script-opt 是
 * script-opts 的追加别名，不会覆盖用户全局 --script-opts 列表）。
 *
 * 本文件内容译自 mpv `etc/menu.conf`（commit 7b8915bc1d，与 vendor 内置构建同源）：
 * 只翻译第一列文案与 show-text 的 OSD 文字，命令列、checked=/hidden=/disabled= 条件
 * 表达式原样保留。格式约束：
 * - 字段间必须用 TAB 分隔（一个或多个均可，此处统一单个）；
 * - 子菜单靠行首空格缩进表达层级（select.lua 按前导空白长度判定，4 空格一级）；
 * - `$playlist`/`$tracks` 等以 $ 开头的第二字段是动态子菜单标记，不可改动。
 *
 * 注意：轨道/章节等二级选择列表的标题硬编码在官方 select.lua 中，menu.conf 无法
 * 汉化；统计面板与控制台同理。
 */

const lines = [];

/** depth: 层级（0=顶级）；fields: [文案, 命令?, 条件?]，空串字段跳过 */
function item(depth, ...fields) {
    lines.push(' '.repeat(depth * 4) + fields.filter(Boolean).join('\t'));
}
/** 分组分隔空行（select.lua 将其作为分隔符处理） */
function gap() {
    lines.push('');
}

item(0, '播放', 'cycle pause', 'hidden=not pause and not idle_active', 'disabled=idle_active');
item(0, '暂停', 'cycle pause', 'hidden=idle_active or pause');
item(0, '停止', 'stop', 'hidden=idle ~= true', 'disabled=idle_active');
gap();

item(0, '打开');
item(1, '剪贴板', 'update-clipboard text; loadfile ${clipboard/text}; show-text \'+ ${clipboard/text}\'');
item(1, '观看历史', 'script-binding select/select-watch-history');
item(1, '稍后观看', 'script-binding select/select-watch-later');
item(1, '播放列表', '$playlist');
gap();

item(0, '轨道', '$tracks');
item(0, '播放控制');
item(1, '图片显示时长', 'hidden=not p["current-tracks/video/image"] or p["current-tracks/audio"]');
item(2, '1 秒', 'set image-display-duration 1', 'checked=image_display_duration == 1');
item(2, '2 秒', 'set image-display-duration 2', 'checked=image_display_duration == 2');
item(2, '5 秒', 'set image-display-duration 5', 'checked=image_display_duration == 5');
item(2, '10 秒', 'set image-display-duration 10', 'checked=image_display_duration == 10');
item(2, '无限', 'set image-display-duration inf', 'checked=image_display_duration == math.huge');
item(1, '倍速');
item(2, '25%', 'set speed 0.25', 'checked=speed == 0.25');
item(2, '50%', 'set speed 0.50', 'checked=speed == 0.50');
item(2, '75%', 'set speed 0.75', 'checked=speed == 0.75');
item(2, '100%', 'set speed 1', 'checked=speed == 1');
item(2, '125%', 'set speed 1.25', 'checked=speed == 1.25');
item(2, '150%', 'set speed 1.50', 'checked=speed == 1.50');
item(2, '175%', 'set speed 1.75', 'checked=speed == 1.75');
item(2, '200%', 'set speed 2', 'checked=speed == 2');
item(2, '400%', 'set speed 4', 'checked=speed == 4');
item(2, '800%', 'set speed 8', 'checked=speed == 8');
gap();
item(1, '设置/清除 A-B 循环点', 'ab-loop');
item(1, '单文件循环', 'cycle-values loop-file inf no', 'checked=loop_file == "inf"');
item(1, '列表循环', 'cycle-values loop-playlist inf no', 'checked=loop_playlist == "inf"');
gap();
item(1, '快进 10 秒', 'seek  10', 'hidden=p["current-tracks/video/image"] and not p["current-tracks/audio"]');
item(1, '快退 10 秒', 'seek -10', 'hidden=p["current-tracks/video/image"] and not p["current-tracks/audio"]');
item(1, '快进 10 分钟', 'seek  600', 'hidden=p["current-tracks/video/image"] and not p["current-tracks/audio"]');
item(1, '快退 10 分钟', 'seek -600', 'hidden=p["current-tracks/video/image"] and not p["current-tracks/audio"]');
gap();
item(1, '重新加载当前文件', 'set file-local-options/start ${=time-pos}; playlist-play-index current yes; show-text "正在重新加载当前文件..."');
gap();
item(1, '下一个文件', 'playlist-next', 'disabled=playlist_count < 2');
item(1, '上一个文件', 'playlist-prev', 'disabled=playlist_count < 2');
gap();
item(1, '下一个子播放列表', 'playlist-next-playlist', 'disabled=playlist_count < 2');
item(1, '上一个子播放列表', 'playlist-prev-playlist', 'disabled=playlist_count < 2');
gap();
item(1, '随机排序', 'playlist-shuffle');
item(1, '取消随机排序', 'playlist-unshuffle');
gap();

item(0, '章节', '$chapters');
item(0, '版本/标题', '$editions');
gap();

item(0, '视频');
item(1, '轨道', '$video-tracks');
gap();
item(1, '填满屏幕', 'no-osd cycle-values panscan 0 1; no-osd set video-unscaled no; no-osd set video-zoom 0', 'checked=panscan == 1');
item(1, '拉伸填充', 'no-osd cycle keepaspect', 'checked=not keepaspect');
item(1, '原始尺寸', 'no-osd cycle-values video-unscaled yes no; no-osd set video-zoom 0; no-osd set panscan 0', 'checked=video_unscaled');
item(1, '缩放');
item(2, '50%', 'set video-zoom -1', 'checked=video_zoom == -1');
item(2, '100%', 'set video-zoom 0', 'checked=video_zoom == 0');
item(2, '200%', 'set video-zoom 1', 'checked=video_zoom == 1');
item(1, '画面比例');
item(2, '16:9', 'set video-aspect-override 16:9', 'checked=math.abs(video_aspect_override - 16/9) < 1e-12');
item(2, '4:3', 'set video-aspect-override 4:3', 'checked=math.abs(video_aspect_override - 4/3) < 1e-12');
item(2, '2.35:1', 'set video-aspect-override 2.35:1', 'checked=video_aspect_override == 2.35');
item(2, '默认', 'set video-aspect-override no', 'checked=video_aspect_override == -2');
item(1, '画面居中', 'no-osd set video-pan-x 0; no-osd set video-pan-y 0; no-osd set video-align-x 0; no-osd set video-align-y 0', 'disabled=video_pan_x == 0 and video_pan_y == 0 and video_align_x == 0 and video_align_y == 0');
gap();
item(1, '顺时针旋转', 'cycle-values video-rotate 90 180 270 0');
item(1, '逆时针旋转', 'cycle-values video-rotate 270 180 90 0');
gap();
item(1, '去色带（deband）', 'cycle deband', 'checked=deband');
item(1, '反交错（deinterlace）', 'cycle deinterlace', 'checked=deinterlace_active');
gap();
item(1, '截图', 'screenshot', 'disabled=not p["current-tracks/video"]');
item(1, '截图（不含字幕）', 'screenshot video', 'disabled=not p["current-tracks/video"]');
gap();

item(0, '音频');
item(1, '轨道', '$audio-tracks');
item(1, '输出设备', '$audio-devices');
item(1, '声道布局');
item(2, '自动', 'set audio-channels auto-safe', 'checked=audio_channels == "auto-safe"');
item(2, '立体声', 'set audio-channels stereo', 'checked=audio_channels == "stereo"');
item(2, '单声道', 'set audio-channels mono', 'checked=audio_channels == "mono"');
gap();
item(1, '音量 +2', 'add volume  2');
item(1, '音量 -2', 'add volume -2');
item(1, '静音', 'cycle mute', 'checked=mute');
gap();
item(1, '音频延迟 +0.1s', 'add audio-delay  0.1');
item(1, '音频延迟 -0.1s', 'add audio-delay -0.1');
gap();

item(0, '字幕');
item(1, '轨道', '$sub-tracks');
item(1, '显示/隐藏字幕', 'cycle sub-visibility', 'checked=sub_visibility');
gap();
item(1, '字幕延迟 +0.1s', 'add sub-delay  0.1');
item(1, '字幕延迟 -0.1s', 'add sub-delay -0.1');
gap();
item(1, '字幕放大', 'add sub-scale  0.1');
item(1, '字幕缩小', 'add sub-scale -0.1');
gap();
item(1, '按字幕行跳转', 'script-binding select/select-subtitle-line',
    'disabled=not sid or p["current-tracks/sub/codec"] == "dvb_subtitle" or p["current-tracks/sub/codec"] == "dvd_subtitle" or p["current-tracks/sub/codec"] == "hdmv_pgs_subtitle"');
item(1, '第二字幕');
item(2, '轨道', '$secondary-sub-tracks');
item(2, '显示/隐藏第二字幕', 'cycle secondary-sub-visibility', 'checked=secondary_sub_visibility');
gap();
item(2, '延迟 +0.1s', 'add secondary-sub-delay  0.1');
item(2, '延迟 -0.1s', 'add secondary-sub-delay -0.1');
gap();
item(2, '按字幕行跳转', 'script-binding select/select-secondary-subtitle-line',
    'disabled=not secondary_sid or p["current-tracks/sub2/codec"] == "dvb_subtitle" or p["current-tracks/sub2/codec"] == "dvd_subtitle" or p["current-tracks/sub2/codec"] == "hdmv_pgs_subtitle"');
gap();

item(0, '窗口');
item(1, '全屏', 'cycle fullscreen', 'checked=fullscreen');
item(1, '边框', 'cycle border', 'checked=border');
item(1, '标题栏', 'cycle title-bar', 'checked=title_bar');
item(1, '总在最前', 'cycle ontop', 'checked=ontop');
item(1, '窗口缩放');
item(2, '50%', 'set window-scale 0.5', 'checked=math.abs(get("current-window-scale", 0) - 0.5) < 0.1');
item(2, '100%', 'set window-scale 1', 'checked=math.abs(get("current-window-scale", 0) - 1) < 0.1');
item(2, '200%', 'set window-scale 2', 'checked=math.abs(get("current-window-scale", 0) - 2) < 0.1');
item(2, '300%', 'set window-scale 3', 'checked=math.abs(get("current-window-scale", 0) - 3) < 0.1');
item(1, '窗口截图', 'screenshot window');
gap();

item(0, '查看');
item(1, '播放统计', 'script-binding stats/display-page-1-toggle');
item(1, '文件信息', 'script-binding stats/display-page-5-toggle');
item(1, '快捷键一览', 'script-binding stats/display-page-4-toggle');
item(1, '时间 OSD 明细', 'no-osd cycle-values osd-level 3 1', 'checked=osd_level == 3');
item(1, '切换 OSC 可见性', 'script-binding osc/visibility');
item(1, 'OSC 布局');
item(2, '底部栏', 'no-osd change-list script-opts append osc-layout=bottombar');
item(2, '顶部栏', 'no-osd change-list script-opts append osc-layout=topbar');
item(2, '浮动', 'no-osd change-list script-opts append osc-layout=floating');
item(2, '盒式', 'no-osd change-list script-opts append osc-layout=box');
item(2, '简约盒式', 'no-osd change-list script-opts append osc-layout=slimbox');
item(2, '极简底部栏', 'no-osd change-list script-opts append osc-layout=slimbottombar', 'hidden=not p["current-tracks/video/image"] or p["current-tracks/audio"]');
item(2, '极简顶部栏', 'no-osd change-list script-opts append osc-layout=slimtopbar', 'hidden=not p["current-tracks/video/image"] or p["current-tracks/audio"]');
gap();

item(0, '配置档', '$profiles');
item(0, '工具');
item(1, '复制文件路径', 'set clipboard/text ${path}', 'disabled=idle_active');
item(1, '复制字幕文本', 'set clipboard/text ${sub-text}',
    'disabled=not sid or p["current-tracks/sub/codec"] == "dvd_subtitle" or p["current-tracks/sub/codec"] == "hdmv_pgs_subtitle"');
item(1, '复制媒体标题', 'set clipboard/text ${media-title}', 'disabled=idle_active');
gap();
item(1, '硬件解码', 'cycle-values hwdec no auto', 'checked=hwdec_current and hwdec_current ~= "no"', 'disabled=p["current-tracks/video/image"] ~= false');
// Anime4K 全局档位：菜单只发信号（script-binding hints/a4k-<mode>，由 hints.lua 写
// user-data），主进程消费后持久化+热应用+回写当前档位；勾选态读 user-data 实时反映。
item(1, 'Anime4K 超分');
item(2, '关闭', 'script-binding hints/a4k-off', 'checked=p["user-data/yuki/a4k-mode"] == "off"');
item(2, '均衡（默认）', 'script-binding hints/a4k-a', 'checked=p["user-data/yuki/a4k-mode"] == "a"');
item(2, '细节增强', 'script-binding hints/a4k-aa', 'checked=p["user-data/yuki/a4k-mode"] == "aa"');
item(2, '仅修复', 'script-binding hints/a4k-restore', 'checked=p["user-data/yuki/a4k-mode"] == "restore"');
item(1, '选择快捷键执行', 'script-binding select/select-binding');
item(1, '查看全部属性', 'script-binding select/show-properties');
item(1, '控制台', 'script-binding commands/open');
gap();
item(1, '编辑 mpv 配置', 'script-binding select/edit-config-file');
item(1, '编辑快捷键配置', 'script-binding select/edit-input-conf');
gap();
item(1, '在线文档', 'script-binding select/open-docs');
item(1, '社区支持', 'script-binding select/open-chat');
gap();

item(0, '退出', 'quit');
item(0, '退出并记住进度', 'quit-watch-later', 'hidden=save_position_on_quit');

module.exports = { MENU_CONF_ZH: lines.join('\n') + '\n' };
