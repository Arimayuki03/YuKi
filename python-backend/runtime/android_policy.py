# -*- coding: utf-8 -*-
"""A4.1 Android Worker feasibility decision exposed to product code.

The spike deliberately does not ship an Android Worker.  Keep the decision in
one small module so an environment variable cannot accidentally turn a C2
source into a supported source after the A4.1 No-Go decision.
"""

SUPPORT_CEILING = 'C1'
ANDROID_WORKER_DECISION = 'NO_GO'
ANDROID_WORKER_SHIPPED = False

ANDROID_ONLY_MESSAGE = (
    '该源仅支持 Android；当前桌面版支持上限为 C1，'
    '不会回退到 dex2jar/JVM。请改用可移植的 CMS、Python、JS、drpy 或 JVM 源。'
)


def android_worker_available(*, enabled=False, ready=False):
    """Return whether the product may route work to an Android Worker.

    ``enabled`` and ``ready`` are retained as future handshake inputs.  They
    cannot override the shipped product policy established by A4.1.
    """
    return bool(ANDROID_WORKER_SHIPPED and enabled and ready)


def android_only_details():
    return {
        'supportCeiling': SUPPORT_CEILING,
        'androidWorkerDecision': ANDROID_WORKER_DECISION,
        'androidWorkerShipped': ANDROID_WORKER_SHIPPED,
        'fallback': 'none',
        'userAction': '改用可移植的 CMS、Python、JS、drpy 或 JVM 源',
    }
