# Foldable store artwork

Editable compositions for the dedicated App Store Duo and Google Play foldable screenshot slots. They follow the existing normal iPhone artwork with Stack Sans Text, cream and amber backgrounds, the MeroSplit wordmark, a split-circle accent and dashed paths.

Run `node store-assets/foldables/render.mjs` from a checkout with Google Chrome installed. The renderer uses an isolated headless Chrome profile, stops within three minutes and removes its profile. It writes the five PNGs and `render-proof.json` beside this file.

| Export | Native capture | Pixels |
| --- | --- | --- |
| apple/01-groups.png | Duo folded Groups, corrected right sidebar | 1398 x 2034 |
| apple/02-opened.png | Duo unfolded Groups, corrected right sidebar | 2853 x 2007 |
| android/01-square.png | Android square bill form | 2106 x 2106 |
| android/02-wide.png | Android unfolded group bills | 2688 x 2016 |
| android/03-folded.png | Android folded bill form | 1260 x 2016 |

The inputs are captures of the actual app running in native simulators with fictional demonstration records. The isolated QA wrapper supplies those records and automation while the production screens remain unchanged. The bill uses Beach dinner and an amount of 1240. The editable HTML adds only surrounding artwork and a decorative frame. It scales each complete capture uniformly. It does not redraw controls, move navigation, change amounts or crop the app display.

`capture-manifest.json` records source revision, QA provenance and input checksums. `render-proof.json` records output checksums, native dimensions and composition geometry. The renderer checks font loading, dimensions, text overlap, canvas bounds and uniform image scale. Visually inspect every output before upload.

The existing normal-phone screenshots and the historical raw 1.2.6 release captures remain separate. Upload only `apple/` to the Duo slot and only `android/` to the foldable slot.

Public update text is exactly `Fix minor bugs`.
