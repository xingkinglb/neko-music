#!/usr/bin/env bash
# 一次性把全部 Electron 离线实测跑一遍，收集每个脚本的结论。
# 只在开发期用；不进打包。执行时间较长（每个脚本都要起一次 Electron）。
cd "$(dirname "$0")/.." || exit 1
# ★ 必须真的 unset（本机 shell 里常带着 ELECTRON_RUN_AS_NODE=1，空值仍算"已设置"，
#   Electron 会当成 node 跑 → 脚本报 exit=9）。用 env -u 而不是 export xxx=。
TESTS="test-round6 test-round7 test-round8 test-round9 test-round10 test-round11 test-round12 test-round13 test-round14 test-round15 test-round16 test-round17 test-round18 test-round19 test-round20 test-round21 test-round22 test-round23 test-round24 test-round25 test-ui test-collect test-keys test-persist test-overlay test-playing test-lyric-drag test-play-interrupt"
OUT=.verify/regression-summary.txt
: > "$OUT"
for t in $TESTS; do
  rep=".verify/${t}-report.txt"
  rm -f "$rep"
  timeout 200 env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox --disable-gpu-sandbox ".verify/${t}.js" >/dev/null 2>&1
  code=$?
  verdict="(无报告)"
  fails=0
  if [ -f "$rep" ]; then
    verdict=$(tail -1 "$rep" | tr -d '\r')
    fails=$(grep -c 'FAIL' "$rep" 2>/dev/null || echo 0)
  fi
  printf '%-22s exit=%-4s FAIL数=%-3s 末行=%s\n' "$t" "$code" "$fails" "$verdict" >> "$OUT"
  printf '%-22s exit=%-4s FAIL数=%-3s 末行=%s\n' "$t" "$code" "$fails" "$verdict"
done
echo "DONE" >> "$OUT"
