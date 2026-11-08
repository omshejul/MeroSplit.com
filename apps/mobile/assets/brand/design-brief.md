# Current MeroSplit mark

The human-supplied amber/coral SVG and layered `merosplit.icon` supersede the earlier Blender mark below. Originals and export limits are recorded in `SOURCE.json`. Do not run the historical Blender exporter for current assets. The layered iOS icon is configured for a future native build; it is not activated by a JavaScript-only update or uncompiled resource copy.

## Alternate iOS icons

People pick these under Account → App icon, or keep Match color so the icon follows their Appearance color. `src/appIcons.ts` lists them. `pnpm icons:generate` rebuilds `app-icons/*.icon` from `merosplit.icon`: the same layer, scale and glass, with the two half colors swapped and an automatic-gradient fill in the icon's ground color. Do not edit those bundles by hand; a test fails when they drift from the list or the primary icon. `plugins/with-app-icons.cjs` adds them to the iOS build as alternate icons, so new or changed icons need a native build. Android keeps one icon, because switching launcher icons there can remove the app from the home screen.

## Historical selection

# MeroSplit linked friends mark

Om selected option3 on17October2026. Two linked matte coral and peach rings, white opaque background, no floor or cast shadow. This Blender scene is the approved master. Preserve its geometry, materials, camera and lighting.

`03-linked-friends.png` is the original1024px RGB render. `03-linked-friends.blend` contains the independent packed scene. For platform exports only, render the same scene with film transparency; retain the original master. App icons use a white opaque square. Android foreground is inset to fit adaptive icon masks. The splash uses the same mark.
