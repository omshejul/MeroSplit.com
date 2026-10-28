# Expense categories

MeroSplit has 74 specific bill categories. `general` is the separate default for unclear or unmatched titles.

Automatic icons send only the raw title to Jev. The instruction names Hugeicons Core Free (`@hugeicons/core-free-icons`) and asks for the best icon for that title. Each choice uses the actual icon identifier as both its key and description, such as `CleaningBucketIcon: CleaningBucketIcon`. The winning icon maps back to the fixed category ID used by clients. The descriptions below document manual categories and are not sent to Jev.

Automatic icons use the highest-probability icon, with no confidence cutoff or required lead. If `general` ranks highest, the bill keeps the receipt icon as a valid cached result. Results are shared across users for the same normalized title.

| Category | ID | Used for |
| --- | --- | --- |
| Food | `food` | Prepared meals, restaurants and takeout when no more specific food or drink category applies. |
| Groceries | `groceries` | Mixed supermarket food and ingredients when no specific produce, meat, seafood, dairy or snacks category applies. |
| Water | `water` | Drinking water, water delivery and water bills. |
| Utilities | `utilities` | Other or mixed utility bills when electricity, cooking gas, water, internet or mobile service is not specifically named. |
| Transport | `transport` | Other local transport and commuting when no more specific transport category applies. |
| Travel | `travel` | General trip expenses when not specifically flights, hotels or another transport category. |
| Rent | `rent` | Rent for a home, room or shared accommodation. |
| Shopping | `shopping` | Other purchased goods when no more specific goods category applies. |
| Entertainment | `entertainment` | Other recreation and entertainment when not specifically movies, music, gaming or sports. |
| Health | `health` | Doctors, hospitals and healthcare other than specific medicine or dental purchases. |
| Education | `education` | General learning and education expenses when not specifically books, stationery or tuition. |
| Coffee | `coffee` | Coffee, espresso and coffee-shop drinks, without a meal. |
| Tea | `tea` | Tea, chai and bubble tea, without a meal. |
| Bakery | `bakery` | Bread, pastries, croissants and bakery purchases. |
| Dessert | `dessert` | Cake, ice cream, sweets and desserts. |
| Fast food | `fastfood` | Pizza, burgers, fries and explicitly named fast-food meals. |
| Alcohol | `alcohol` | Beer, wine, spirits and bar drinks. |
| Fruit and vegetables | `produce` | Fresh fruit and vegetables bought as groceries. |
| Meat | `meat` | Meat and poultry bought as groceries. |
| Seafood | `seafood` | Fish and seafood bought as groceries. |
| Dairy | `dairy` | Milk, cheese, yogurt and other dairy groceries. |
| Snacks | `snacks` | Packaged snacks, chips, popcorn and snack purchases. |
| Electricity | `electricity` | Electricity bills, power bills and prepaid electricity. |
| Cooking gas | `gas` | Cooking gas, LPG cylinders and household gas bills; not vehicle fuel. |
| Internet | `internet` | Broadband, Wi-Fi and home internet bills. |
| Mobile service | `mobile` | Mobile recharge, cellular plans and phone service bills; not phone hardware. |
| Household supplies | `household` | Kitchenware and everyday household supplies, excluding cleaning products and furniture. |
| Cleaning | `cleaning` | Cleaning supplies, housekeeping and cleaning services. |
| Laundry | `laundry` | Laundry, dry cleaning and clothes washing services. |
| Home repairs | `repairs` | Home repairs, plumbing, electricians and maintenance services; not vehicle repairs. |
| Furniture | `furniture` | Furniture, sofas, chairs, beds and home furnishings. |
| Appliances | `appliances` | Home appliances such as a fridge, washing machine or microwave. |
| Electronics | `electronics` | Computers, phones, electronics and hardware accessories; not service bills or software. |
| Clothing | `clothing` | Clothes, shirts, dresses and apparel; not footwear. |
| Footwear | `footwear` | Shoes, sandals, boots and other footwear. |
| Personal care | `beauty` | Cosmetics, skincare, perfume and personal-care products. |
| Hair and grooming | `haircut` | Haircuts, barber, salon and grooming services. |
| Taxi and rideshare | `taxi` | Taxi, cab, Uber, Ola and rideshare fares. |
| Bus | `bus` | Bus and coach tickets or fares. |
| Train | `train` | Railway and train tickets; not metro or subway. |
| Metro | `metro` | Metro, subway and urban rail fares. |
| Vehicle fuel | `fuel` | Petrol, diesel, gasoline, vehicle charging and other vehicle fuel. |
| Parking | `parking` | Parking charges and parking passes. |
| Tolls | `tolls` | Road tolls, highway tolls and FASTag charges. |
| Cycling | `cycling` | Bicycle hire, cycling equipment and bicycle maintenance. |
| Vehicle maintenance | `carmaintenance` | Vehicle servicing, repairs, tyres and car washing. |
| Flights | `flights` | Airline tickets, flights and airline baggage charges. |
| Hotels | `hotel` | Hotels, hostels, resorts and short-stay travel accommodation. |
| Movies | `movies` | Cinema and movie theatre tickets or rentals. |
| Music | `music` | Music, concerts, music lessons and music services. |
| Gaming | `gaming` | Video games, game purchases and gaming services. |
| Sports | `sports` | Sports equipment, sports events and court or ground hire; not gym memberships. |
| Fitness | `fitness` | Gym memberships, fitness classes, yoga and workout training. |
| Books | `books` | Books, ebooks and audiobooks; not tuition or stationery. |
| Stationery | `stationery` | Pens, notebooks, printing and school or office stationery. |
| Tuition and courses | `tuition` | School or college fees, tuition, paid courses and training. |
| Childcare | `childcare` | Childcare, babysitting, nursery and baby supplies. |
| Pets | `pets` | Pet food, pet supplies, grooming and veterinary care. |
| Gifts | `gifts` | Gifts, presents and gift cards. |
| Donations | `charity` | Charitable donations and contributions. |
| Insurance | `insurance` | Insurance premiums and insurance payments. |
| Taxes | `taxes` | Taxes, government tax payments and tax filing fees. |
| Bank fees | `bankfees` | Bank charges, card fees, ATM fees and transaction fees; not transfers or purchases. |
| Shipping | `shipping` | Postage, courier, parcel delivery and shipping charges; not food delivery. |
| Office | `office` | Coworking, office space and business office expenses excluding stationery and hardware. |
| Medicine | `medicine` | Pharmacy purchases, medicines and prescriptions. |
| Dental care | `dental` | Dentists, dental treatment and dental supplies. |
| Flowers | `flowers` | Flowers, bouquets and florist purchases. |
| Photography | `photography` | Photography services, camera equipment and photo printing. |
| Subscriptions | `subscriptions` | A general recurring subscription not specifically music, gaming, internet or software. |
| Software | `software` | Software licenses, apps, cloud storage and software subscriptions. |
| Garbage | `garbage` | Rubbish and waste. |
| Waste collection | `wastecollection` | Garbage trucks and waste collection. |
| Recycling | `recycling` | Recycling and recyclable materials. |
