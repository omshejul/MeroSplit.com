# Expense icons

MeroSplit uses 62 bill categories. The shared catalog and legacy aliases live in `apps/api/ledger/assets/expense-icons.json`. The app picker, Jev and MCP use this vocabulary. The picker supports category search.

Jev receives only the raw title and fixed category meanings. It prefers specific categories when the title supports them, with broad categories and Other for unclear titles. Highest probability wins without a confidence cutoff. Normalized titles share results across accounts; access and manual-choice checks remain per bill.

| Category | ID | Used for |
| --- | --- | --- |
| Other | `general` | Receipts, miscellaneous expenses or an unclear title. |
| Food | `food` | Meals, restaurants, takeaway, bakeries and desserts. |
| Drinks | `drinks` | Other non-alcoholic drinks, juices and soft drinks; use Coffee & tea or Liquor when clear. |
| Groceries | `groceries` | Groceries, produce, meat, fish, dairy and snacks. |
| Utilities | `utilities` | Other utility bills; use Electricity, Heating & gas, Water or TV, phone & internet when clear. |
| Transport | `transport` | Other transport expenses when no specific vehicle, transit, taxi, fuel, parking or toll category fits. |
| Transit | `transit` | Buses, trains, metro and other public transport. |
| Travel | `travel` | Other trip and travel expenses; use Flights and Hotel when clear. |
| Home & family | `home` | Other home and family expenses; use rent, mortgage, supplies, furniture, maintenance or childcare when clear. |
| Shopping | `shopping` | Other shopping purchases; use Clothing, Electronics, Appliances or Personal care when clear. |
| Health | `health` | Healthcare, medicines and dental care. |
| Education | `education` | Books, stationery, tuition, courses and school expenses. |
| Leisure | `entertainment` | Other entertainment and leisure activities; use Movies, Music, Games or Sports when clear. |
| Fitness | `fitness` | Sports, exercise and gym expenses. |
| Work | `work` | Office expenses, professional tools and work software. |
| Gifts & giving | `gifts` | Gifts, flowers, donations and charity. |
| Pets | `pets` | Pet food, care and veterinary expenses. |
| Fees & taxes | `fees` | Other financial and recurring fees; use Bank fees, Insurance, Taxes or Subscriptions when clear. |
| Services | `services` | Other services, general repairs and delivery services; use Home maintenance, Cleaning, Laundry or Moving when clear. |
| Waste | `waste` | Refuse collection, rubbish disposal and recycling services. |
| Coffee & tea | `coffee` | Coffee, tea and cafe drinks; not alcoholic drinks. |
| Liquor | `alcohol` | Beer, wine, spirits and other alcoholic drinks. |
| Takeaway | `takeaway` | Takeaway meals and food delivery, including delivery charges on the meal. |
| Movies | `movies` | Cinema tickets and movie rentals; not recurring streaming subscriptions. |
| Music | `music` | Music purchases, instruments and concerts; not recurring subscriptions. |
| Games | `gaming` | Video games, board games and gaming purchases. |
| Sports | `sports` | Sports matches, equipment and participation; use Fitness for gym and exercise. |
| Electronics | `electronics` | Computers, phones and electronic devices; not household appliances. |
| Furniture | `furniture` | Furniture such as beds, sofas, desks and chairs. |
| Household supplies | `household` | Household consumables, toiletries, kitchenware and cleaning products; not cleaning services. |
| Home maintenance | `maintenance` | Home repairs, plumbing, electrical work and property maintenance; not vehicle repairs. |
| Mortgage | `mortgage` | Mortgage instalments and home loan payments; not rent or security deposits. |
| Rent | `rent` | Rent for a home, room or apartment; not mortgage or refundable deposits. |
| Appliances | `appliances` | Household appliances such as fridges, washing machines and ovens. |
| Childcare | `childcare` | Babysitting, daycare and childcare expenses. |
| Clothing | `clothing` | Clothes, shoes and clothing accessories. |
| Personal care | `beauty` | Haircuts, salon, skincare, cosmetics and personal grooming services. |
| Insurance | `insurance` | Insurance premiums for health, life, home, travel or vehicles. |
| Taxes | `taxes` | Government taxes and tax payments; not bank fees or insurance. |
| Bicycle | `cycling` | Bicycle purchases, cycle hire, bike accessories and bicycle repairs. |
| Car | `car` | Car purchases and general vehicle expenses; use specific fuel, rental, parking or repair choices when clear. |
| Gas & fuel | `fuel` | Petrol, diesel, vehicle charging and other vehicle fuel; not home heating gas. |
| Hotel | `hotel` | Hotels, hostels, resorts and holiday accommodation. |
| Parking | `parking` | Vehicle parking charges and parking permits. |
| Flights | `flights` | Airline tickets, flight baggage and airline fees. |
| Taxi & rideshare | `taxi` | Taxis, cabs and rideshare trips such as Uber or Ola. |
| Tolls | `tolls` | Road, bridge and motorway tolls, including FASTag. |
| Car rental | `carrental` | Car and motor vehicle rental or hire; not taxis or bicycle hire. |
| Car repair | `carmaintenance` | Motor vehicle repairs, servicing, tyres and maintenance; not home repairs. |
| Cleaning | `cleaning` | House cleaning services, housekeepers and maids; not cleaning supplies or laundry. |
| Electricity | `electricity` | Electricity bills and power charges; not vehicle charging. |
| Heating & gas | `gas` | Home heating, cooking gas, LPG cylinders and gas utility bills; not vehicle fuel. |
| TV, phone & internet | `connectivity` | Broadband, internet, mobile, landline and cable or satellite TV bills. |
| Water | `water` | Water supply bills and drinking water delivery. |
| Laundry | `laundry` | Laundry, dry cleaning and ironing services. |
| Subscriptions | `subscriptions` | Recurring memberships, streaming and personal app subscriptions; not utility bills, insurance or work software. |
| Donations | `charity` | Charitable donations, fundraising and religious giving; not personal gifts. |
| Pharmacy | `medicine` | Medicines, prescriptions and pharmacy purchases; not doctor visits. |
| Dental | `dental` | Dentist appointments, dental treatment and dental care. |
| Moving | `moving` | Moving home, movers, packing and relocation services. |
| Security deposit | `deposit` | Refundable rental or property security deposits; not rent or mortgage. |
| Bank fees | `bankfees` | Bank account charges, card fees, transfer fees and ATM fees. |

## Selection and backfill

MCP `get_account_context.icon_options` lists allowed values. Set `save_expense.icon` only when requested; `general` explicitly selects Other, `auto` restores inference. Omission infers on create and preserves selection on edit. Retries retain the same choice.

Migration 0042 queues eligible automatic bills under the new catalog revision. Titles are deduplicated, and the existing worker calls Jev after commit. Manual choices, removed content, reversed bills, unavailable accounts, amounts, splits, versions, history and notification outboxes are preserved. Older specific manual category IDs resolve to their specific choices. Undispatched older work is retired; in-flight and uncertain dispatch records remain fenced. Repeated migrations reuse the new revision without repeating calls.
