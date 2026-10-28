# Component gallery

`ComponentGallery.tsx` renders production components with synthetic accounts, bills and API responses. It is excluded from the production entry point.

For manual checks, temporarily register the gallery instead of `App` in `index.ts`, start Expo with a five-minute shutdown timer, and open an existing development client. Restore `index.ts` afterwards. The gallery intercepts only its fixture API origin and never uses a real account.

Check rows, states, selectors, dialogs, profile, expenses, payments, groups, members, bill details, payment details, saved changes, recovery, activity, versions, attachments, photos, creation, sign-in, providers, notifications, MCP, import, tabs and joining. Exercise callbacks, disabled and retry states, keyboard footers, currency choices, light/dark appearance and large text.

Automated contracts are covered by `sharedComponents.test.ts`, `rowDividers.test.ts` and the screen regression tests. Native operation still requires a simulator or device.
