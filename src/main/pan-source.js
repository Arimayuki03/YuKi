'use strict';
/** 网盘类源识别（夸克 / UC / 阿里 / 115 / 123 / 天翼 / 移动等）。
 *
 *  原生播放列表对网盘资源全局禁用（2026-08-26）：
 *  - 网盘解析慢且依赖 Cookie 会话，整季装载进播放列表会放大风控概率；
 *  - 网盘直链是短时效签名地址，队列里的后续集数在真正打开时才解析，
 *    逐集连播链路（渲染层 _onExit 推进）才是可靠形态；
 *  - 外部主播放器的整季 m3u 同样源自建队请求，此处一并拦截。
 *
 *  消费方：
 *  - 主进程 yuki:playlist-build（isPanQueueRequest：拒绝建队 → 渲染层静默回退逐集）
 *  - 主进程 isDynamicProxyStream（边下边播排除，正则同源）
 *  - 渲染层 player.js 提前跳过原生队列分支（浏览器上下文无法 require 主进程
 *    模块，正则以注释互引保持一致——改动时务必同步三处）。 */

// 站点/线路名与播放地址的网盘特征。「夸克」「云盘」为中文站点名补充——
// 「夸克云盘」不命中 quark/pan/网盘 任一既有子串；「网盘」「云盘」互不包含，需并列。
const PAN_SOURCE_RE = /pan|quark|夸克|uc网盘|网盘|云盘|aliyun|ali|115|123|天翼|移动/i;

/**
 * 播放列表建队请求是否网盘类源（原生播放列表对其禁用）。
 * 判定面：kind 非 kazumi 且「site | flag | 各集 id/url」命中 PAN_SOURCE_RE。
 * Kazumi 是番剧规则引擎，规则名含「ali/移动」等子串会被误伤，不做过滤。
 * @param {{kind?: string, site?: string, flag?: string, eps?: Array<{id?: string}>}} queue
 * @returns {boolean}
 */
function isPanQueueRequest(queue) {
    const q = queue || {};
    if (String(q.kind || '') === 'kazumi') return false;
    const epsText = Array.isArray(q.eps)
        ? q.eps.map((e) => String((e && (e.id != null ? e.id : '')) || '')).join('|')
        : '';
    return PAN_SOURCE_RE.test(`${String(q.site || '')}|${String(q.flag || '')}|${epsText}`);
}

module.exports = { PAN_SOURCE_RE, isPanQueueRequest };
