#!/usr/bin/env bash
# 把 PvZ-Godot 导出成 Web 版，并把产物拷进插件目录。
#   用法: ./export-web.sh /path/to/PvZ-Godot /path/to/dsh-pvz/plugin/game
#   依赖: Godot 4.5.1 + web_nothreads_release 导出模板
set -euo pipefail

GAME_DIR="${1:?PvZ-Godot 目录}"
OUT_DIR="${2:?插件 game 目录}"
GODOT="${GODOT_BIN:-godot}"

mkdir -p "$OUT_DIR"
"$GODOT" --headless --path "$GAME_DIR" --export-release "Web" "$OUT_DIR/index.html" > "$OUT_DIR/export.log" 2>&1 || {
  echo "导出失败，看 $OUT_DIR/export.log"; tail -30 "$OUT_DIR/export.log"; exit 1
}
# 导出产物里 index.audio*.worklet.js 少一个，Web Audio 就会 404
ls -la "$OUT_DIR" | sed -n '1,12p'
echo "导出完成：$OUT_DIR"
