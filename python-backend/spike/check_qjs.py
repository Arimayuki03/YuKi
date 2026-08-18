import sys
import json
import traceback

print(f"Python: {sys.version}")
try:
    import quickjs
    ctx = quickjs.Context()
    res = ctx.eval("1 + 1")
    print(f"QuickJS eval 1+1: {res}")
except Exception as e:
    print(f"QuickJS error: {e}")
