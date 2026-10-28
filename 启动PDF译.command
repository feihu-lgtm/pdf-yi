#!/bin/bash
# 轻量版：在本机起一个只给自己用的小服务，然后用浏览器打开 PDF译。
# 关掉：双击“关掉PDF译.command”，或者重启电脑。
cd "$(dirname "$0")/www" || { echo "找不到 www 文件夹"; read -n1; exit 1; }
PORT=3427
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  nohup /usr/bin/env python3 -m http.server $PORT --bind 127.0.0.1 >/tmp/pdfyi-server.log 2>&1 &
  for i in 1 2 3 4 5 6 7 8 9 10; do
    lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1 && break
    sleep 0.3
  done
fi
if ! lsof -nP -iTCP:$PORT -sTCP:LISTEN >/dev/null 2>&1; then
  echo "端口 $PORT 没起来，看一下 /tmp/pdfyi-server.log"; read -n1; exit 1
fi
open "http://127.0.0.1:$PORT/index.html"
