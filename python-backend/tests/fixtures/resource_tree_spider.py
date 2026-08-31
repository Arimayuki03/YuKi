import json
import socket
import subprocess
import sys
import time

from base.spider import Spider as BaseSpider


PYTHON_CHILD = (
    "import socket,sys,time; "
    "s=socket.socket(); s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); "
    "s.bind(('127.0.0.1',int(sys.argv[1]))); s.listen(8); "
    "exec(\"while True:\\n c,_=s.accept()\\n c.close()\")"
)
NODE_CHILD = (
    "const net=require('net'); const p=Number(process.argv[1]); "
    "net.createServer(()=>{}).listen(p,'127.0.0.1'); "
    "setInterval(()=>{},600000);"
)


def _port_ready(port):
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    probe.settimeout(0.1)
    try:
        return probe.connect_ex(('127.0.0.1', int(port))) == 0
    finally:
        probe.close()


class Spider(BaseSpider):
    _instance = None

    def init(self, extend=''):
        data = dict(extend) if isinstance(extend, dict) else json.loads(extend or '{}')
        python_port = int(data['pythonPort'])
        node_port = int(data['nodePort'])
        node_exe = str(data['nodeExe'])
        flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
        self.python_child = subprocess.Popen(
            [sys.executable, '-c', PYTHON_CHILD, str(python_port)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, creationflags=flags,
        )
        self.node_child = subprocess.Popen(
            [node_exe, '-e', NODE_CHILD, str(node_port)],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL, creationflags=flags,
        )
        # CI runner 上双子进程（python/node）冷启动受 Defender 扫描与冷文件缓存
        # 影响，5s 窗口曾把「就绪慢」误判为失败；等待放宽不改变测试语义
        # （destroy 后资源仍必须被 Supervisor 进程树边界强制回收）。
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if _port_ready(python_port) and _port_ready(node_port):
                break
            if self.python_child.poll() is not None or self.node_child.poll() is not None:
                raise RuntimeError('resource child exited during startup')
            time.sleep(0.02)
        else:
            raise RuntimeError('resource child ports did not become ready')
        with open(data['pidFile'], 'w', encoding='utf-8') as stream:
            json.dump({
                'pythonPid': self.python_child.pid,
                'nodePid': self.node_child.pid,
                'pythonPort': python_port,
                'nodePort': node_port,
            }, stream)

    def getName(self):
        return 'Resource Tree Fixture'

    def homeContent(self, _filter):
        return {'list': []}

    def destroy(self):
        # Deliberately leave descendants to the Supervisor process-tree
        # boundary. A cooperative fixture cleanup would not test hard recycle.
        return None
