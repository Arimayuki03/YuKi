import json
import socket
import subprocess
import sys
import threading
import time


PYTHON_CHILD = (
    "import socket,sys,time; s=socket.socket(); "
    "s.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); "
    "s.bind(('127.0.0.1',int(sys.argv[1]))); s.listen(8); "
    "exec(\"while True:\\n c,_=s.accept()\\n c.close()\")"
)
NODE_CHILD = (
    "const net=require('net'); const p=Number(process.argv[1]); "
    "net.createServer(()=>{}).listen(p,'127.0.0.1'); setInterval(()=>{},600000);"
)


def ready(port):
    probe = socket.socket()
    probe.settimeout(0.1)
    try:
        return probe.connect_ex(('127.0.0.1', int(port))) == 0
    finally:
        probe.close()


def main():
    root_port, python_port, node_port, java_port = map(int, sys.argv[1:5])
    node_exe, java_exe, java_classes = sys.argv[5:8]
    flags = getattr(subprocess, 'CREATE_NO_WINDOW', 0)
    root_socket = socket.socket()
    root_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    root_socket.bind(('127.0.0.1', root_port))
    root_socket.listen(8)

    def accept_root():
        while True:
            client, _address = root_socket.accept()
            client.close()

    threading.Thread(target=accept_root, daemon=True).start()
    python_child = subprocess.Popen(
        [sys.executable, '-c', PYTHON_CHILD, str(python_port)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, creationflags=flags)
    node_child = subprocess.Popen(
        [node_exe, '-e', NODE_CHILD, str(node_port)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, creationflags=flags)
    java_child = subprocess.Popen(
        [java_exe, '-cp', java_classes, 'ResourceTreeChild', str(java_port)],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL, creationflags=flags)
    deadline = time.monotonic() + 10
    while time.monotonic() < deadline:
        if all(ready(port) for port in (root_port, python_port, node_port, java_port)):
            print(json.dumps({
                'rootPid': __import__('os').getpid(),
                'pythonPid': python_child.pid,
                'nodePid': node_child.pid,
                'javaPid': java_child.pid,
                'ports': [root_port, python_port, node_port, java_port],
            }), flush=True)
            while True:
                time.sleep(60)
        if any(child.poll() is not None for child in (python_child, node_child, java_child)):
            raise RuntimeError('resource tree child exited during startup')
        time.sleep(0.02)
    raise RuntimeError('resource tree ports did not become ready')


if __name__ == '__main__':
    main()
