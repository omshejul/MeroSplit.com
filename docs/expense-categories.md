# Expense icons

MeroSplit uses 20 broad bill icons, including Other for unclear titles. The catalog and legacy aliases live in `apps/api/ledger/assets/expense-icons.json`. The app picker, Jev choices and MCP options use this vocabulary.

Jev receives only the raw title and these fixed icon meanings. The highest-probability choice wins without a confidence cutoff. Other is a valid cached result. Results are shared for the same normalized title, with per-bill access and manual-choice checks.

| Icon | ID | Used for |
| --- | --- | --- |
| Other | `general` | Receipts, miscellaneous expenses or an unclear title. |
| Food | `food` | Meals, restaurants, takeaway, bakeries and desserts. |
| Drinks | `drinks` | Coffee, tea, soft drinks and alcoholic drinks. |
| Groceries | `groceries` | Groceries, produce, meat, fish, dairy and snacks. |
| Utilities | `utilities` | Electricity, water, gas, internet and mobile bills. |
| Transport | `transport` | Taxis, driving, fuel, parking, tolls, cycling and vehicle maintenance. |
| Transit | `transit` | Buses, trains, metro and other public transport. |
| Travel | `travel` | Flights, accommodation and trips. |
| Home & family | `home` | Rent, household goods, furniture, appliances and childcare. |
| Shopping | `shopping` | Clothes, shoes, electronics, beauty and personal care. |
| Health | `health` | Healthcare, medicines and dental care. |
| Education | `education` | Books, stationery, tuition, courses and school expenses. |
| Leisure | `entertainment` | Movies, music, games, events and leisure activities. |
| Fitness | `fitness` | Sports, exercise and gym expenses. |
| Work | `work` | Office expenses, professional tools and work software. |
| Gifts & giving | `gifts` | Gifts, flowers, donations and charity. |
| Pets | `pets` | Pet food, care and veterinary expenses. |
| Fees & taxes | `fees` | Bank fees, insurance, taxes and general recurring fees. |
| Services | `services` | Cleaning, laundry, repairs, maintenance and delivery services. |
| Waste | `waste` | Refuse collection, rubbish disposal and recycling services. |

## MCP selection

Read `get_account_context.icon_options` for the live allowed values and descriptions. `save_expense` accepts optional top-level `icon`, separate from its bill payload. Set a fixed icon only when the user requests one. For example, `icon: "drinks"` sets the drink icon, `icon: "general"` explicitly sets Other, and `icon: "auto"` restores Jev selection. Omit icon and legacy category fields on a new bill to infer automatically. Omission on an edit preserves the saved choice. Retries retain the exact command and icon.

## Existing bills

Legacy specific categories keep their stored values but display a broad icon. Coffee, tea and alcohol share Drinks; water and electricity share Utilities; bus, train and metro share Transit; garbage and recycling share Waste. Manual choices take precedence over automatic hints.

Migration 0037 queues eligible existing automatic bills under the new catalog revision and repairs untouched version 1 MCP generic defaults that previously suppressed inference. The worker performs Jev calls after the migration commits. It preserves later manual choices, amounts, splits, descriptions, versions, history and notification outboxes. Uncertain provider outcomes retain their dispatch fence rather than retrying on every visit.
