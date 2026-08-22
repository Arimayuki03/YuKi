import os
import subprocess
import sys
from base.spider import Spider as BaseSpider


class Spider(BaseSpider):
    _instance = None

    def init(self, extend=''):
        self.extend = extend

    def getName(self):
        return 'Offline Infinite'

    def homeContent(self, filter):
        self._spawn_fixture_child()
        while True:
            pass

    def _spawn_fixture_child(self):
        if getattr(self, '_fixture_child', None) is not None:
            return
        self._fixture_child = subprocess.Popen(
            [sys.executable, '-c', 'import time; time.sleep(600)'],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        path = os.environ.get('YUKI_COMPAT_CHILD_PID_FILE', '')
        if path:
            with open(path, 'w', encoding='ascii') as f:
                f.write(str(self._fixture_child.pid))

    def destroy(self):
        return None
