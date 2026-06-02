#!/bin/bash
set -e

if [ -z "$1" ]; then
  echo "Usage: ./install_mac.sh <extension_id>"
  echo "You can find your extension ID in chrome://extensions after loading AegisStream unpacked."
  exit 1
fi

EXTENSION_ID=$1
DIR="$( cd "$( dirname "$0" )" && pwd )"
BINARY_DIR="$DIR/bin"
BINARY_PATH="$BINARY_DIR/aegisstream-daemon"

# Compile Go daemon
echo "Compiling Native Daemon..."
mkdir -p "$BINARY_DIR"
cd "$DIR"

# Initialize go module if not exists
if [ ! -f "go.mod" ]; then
  go mod init aegisstream-daemon
fi

go build -o "$BINARY_PATH" main.go

# Host config
HOST_NAME="com.aegisstream.daemon"
TARGET_DIR="$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts"
mkdir -p "$TARGET_DIR"
MANIFEST_FILE="$TARGET_DIR/$HOST_NAME.json"

echo "Generating Manifest at $MANIFEST_FILE..."
cat << EOF > "$MANIFEST_FILE"
{
  "name": "$HOST_NAME",
  "description": "AegisStream Multi-Path Racing Engine",
  "path": "$BINARY_PATH",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://$EXTENSION_ID/"
  ]
}
EOF

echo "Native Daemon installed successfully."
echo "Binary path: $BINARY_PATH"
echo "Manifest path: $MANIFEST_FILE"
