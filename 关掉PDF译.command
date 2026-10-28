#!/bin/bash
# 关掉轻量版的小服务（只关 3427 端口上的那一个）
PIDS=$(lsof -nP -t -iTCP:3427 -sTCP:LISTEN 2>/dev/null)
if [ -n "$PIDS" ]; then kill $PIDS && echo "PDF译 的小服务已经关了"; else echo "PDF译 没在运行"; fi
sleep 1
