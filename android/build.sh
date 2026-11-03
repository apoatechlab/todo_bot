#!/usr/bin/env bash
# Builds the «Сегодня» screen saver APK without Gradle: aapt2 → javac → d8 →
# zipalign → apksigner. Needs JDK 11+ and the Android SDK (build-tools 35,
# platform 35). With --install it also installs it on the adb device.
set -euo pipefail
cd "$(dirname "$0")"

SDK="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-/opt/homebrew/share/android-commandlinetools}}"
BT="$SDK/build-tools/35.0.0"
JAR="$SDK/platforms/android-35/android.jar"
KS="$HOME/.android/debug.keystore"
OUT=build

rm -rf "$OUT" && mkdir -p "$OUT/classes"

"$BT/aapt2" link -o "$OUT/base.apk" -I "$JAR" --manifest AndroidManifest.xml \
  --min-sdk-version 26 --target-sdk-version 35 --version-code 1 --version-name 1.0

javac --release 11 -classpath "$JAR" -d "$OUT/classes" $(find src -name "*.java")
"$BT/d8" --release --lib "$JAR" --min-api 26 --output "$OUT" $(find "$OUT/classes" -name '*.class')

cp "$OUT/base.apk" "$OUT/unsigned.apk"
(cd "$OUT" && zip -q unsigned.apk classes.dex)
"$BT/zipalign" -f 4 "$OUT/unsigned.apk" "$OUT/aligned.apk"

if [ ! -f "$KS" ]; then
  mkdir -p "$(dirname "$KS")"
  keytool -genkeypair -keystore "$KS" -storepass android -keypass android \
    -alias androiddebugkey -keyalg RSA -validity 10000 -dname "CN=Android Debug,O=Android,C=US"
fi
"$BT/apksigner" sign --ks "$KS" --ks-pass pass:android --out "$OUT/wall-dream.apk" "$OUT/aligned.apk"
echo "built $OUT/wall-dream.apk"

if [ "${1:-}" = "--install" ]; then
  "$SDK/platform-tools/adb" install -r "$OUT/wall-dream.apk"
fi
