# MeroSplit

- Preserve OTA compatibility by default. Get the user's explicit approval before changing app versions, iOS build numbers, Android versionCode, runtime policy, OTA project/channel, or native fingerprint inputs such as Expo/React Native versions, native dependencies, plugins, configuration, capabilities or bundled native assets. A routine feature, fix or OTA request does not authorize these changes.
- Before publishing an OTA, compare its exact runtime, project and channel against the actual packaged metadata of the public and latest submitted store builds. Report which builds can receive it; version numbers and a successful upload alone do not prove compatibility.
- If work would break existing OTA compatibility, explain the affected builds and obtain approval first. Never override or falsify a runtime/fingerprint to force delivery, or silently create a replacement native release.
