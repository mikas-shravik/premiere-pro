#!/bin/bash
# Builds Storyboard.app (default: ~/Applications). Opening the app starts the
# local Storyboard server in the background, if it isn't running yet, and
# opens Storyboard in your default browser. Keep it in the Dock.
#
#   bash make-mac-app.sh                      # ~/Applications/Storyboard.app
#   bash make-mac-app.sh /Applications/Storyboard.app
#
# Re-run it if you move this folder. Quit from Storyboard's home screen.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
APP="${1:-$HOME/Applications/Storyboard.app}"

if [ -n "${PYTHON:-}" ]; then PY="$PYTHON"
elif [ -x "$HERE/../.venv/bin/python3" ]; then PY="$HERE/../.venv/bin/python3"
else PY="$(command -v python3 || true)"
fi
if [ -z "$PY" ]; then
  echo "python3 not found. Install it first: brew install python" >&2
  exit 1
fi
case "$HERE$PY" in *\"*|*\\*)
  echo "Please move this folder to a path without quotes or backslashes." >&2
  exit 1;;
esac

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

cat > "$WORK/main.applescript" <<EOF
on run
	do shell script "cd " & quoted form of "$HERE" & " && (" & quoted form of "$PY" & " server.py >> /tmp/storyboard.log 2>&1 &)"
end run
EOF

mkdir -p "$(dirname "$APP")"
rm -rf "$APP"
osacompile -o "$APP" "$WORK/main.applescript"

# App icon from app/icon-1024.png
ICONSET="$WORK/Storyboard.iconset"
mkdir "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z "$s" "$s" "$HERE/app/icon-1024.png" --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s * 2)) $((s * 2)) "$HERE/app/icon-1024.png" --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/applet.icns"
# Re-sign (ad hoc) so the new icon doesn't leave a broken signature.
codesign --force --deep --sign - "$APP" >/dev/null 2>&1 || true
touch "$APP"

echo "Created $APP"
echo "Open it from Finder (or drag it to the Dock). Projects are saved in ~/Documents/Storyboards."
