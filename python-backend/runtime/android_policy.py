# -*- coding: utf-8 -*-
"""Android Worker policy and the desktop JVM fallback metadata."""

SUPPORT_CEILING = 'C1'
ANDROID_WORKER_DECISION = 'NO_GO'
ANDROID_WORKER_SHIPPED = False

ANDROID_ONLY_MESSAGE = (
    '该源包含 Android/Dex/native 特征；桌面版将尝试 dex2jar/JVM 回退。'
    '若运行时仍缺少 Android 能力，会返回实际运行时错误。'
)


def android_worker_available(*, enabled=False, ready=False):
    """Android Worker remains unavailable; desktop uses the JVM fallback instead."""
    return bool(ANDROID_WORKER_SHIPPED and enabled and ready)


def android_only_details():
    return {
        'supportCeiling': SUPPORT_CEILING,
        'androidWorkerDecision': ANDROID_WORKER_DECISION,
        'androidWorkerShipped': ANDROID_WORKER_SHIPPED,
        'fallback': 'dex2jar/JVM',
        'userAction': '查看实际运行时错误并按源实现处理',
    }