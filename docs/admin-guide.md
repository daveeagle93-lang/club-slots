# Admin guide

Setting up or moving the site is covered in [deploying.md](deploying.md) and [handover.md](handover.md); this guide is for running it day to day.

It is written for a club organiser using a phone. Every button name below is in "quotes", exactly as it appears on screen. All times are London time, whatever your phone is set to.

Every admin page except the sign-in page has a row of links under the club's header: "Events", "Templates" and "Settings". The page you are on is underlined and in bold. Use them to get between the pages. On a narrow phone the row wraps onto a second line rather than running off the side. I haven't tried this on a real phone, only in tests that read the page files and in a simulated browser.

## Contents

1. [Signing in](#1-signing-in)
2. [Club settings and branding](#2-club-settings-and-branding)
3. [Creating an event](#3-creating-an-event)
4. [Templates](#4-templates)
5. [Sharing to WhatsApp](#5-sharing-to-whatsapp)
6. [Fixing bookings](#6-fixing-bookings)
7. [Editing an event](#7-editing-an-event)
8. [The lineup](#8-the-lineup)
9. [Exporting bookings](#9-exporting-bookings)
10. [Archiving, deleting and clearing out old events](#10-archiving-deleting-and-clearing-out-old-events)
11. [If something looks wrong](#11-if-something-looks-wrong)

## 1. Signing in

This part gets you into the admin pages and tells you what to do when you are signed out.

There are two ways to sign in. Which one you have depends on how your club's site was set up. Most sites use the password screen. A brand new site has to make its admin secret first, as in the next part.

### The first time: making your admin secret

A new site has no admin secret yet. You make it once, from the site's own address. You do not need a code to type.

1. Open your site's address. (If you cannot find it, the [README](../README.md#first-run-setup) shows where.) On a new site this takes you to a page that says the site has no admin yet. Do this soon after the site is deployed: the page is open for 30 minutes. After that the address just shows the ordinary home page, and you need the steps below.
2. Tap "Create my admin secret".
3. The page shows two long strings of letters and numbers: your **admin secret** and your **recovery code**. Each is shown only this once, and the site keeps only a scrambled copy that can't be turned back into it. Tap "Copy admin secret" and save it in your password manager now. Then tap "Copy recovery code" and save that too, ideally as a separate entry.
4. Tick "I've saved both".
5. Tap "Go to sign in" and sign in as in the next part, with the admin secret.

You sign in with the admin secret. The recovery code is for the day you lose the admin secret: see "Lost the admin secret" below.

The 30 minutes count from when the site was first built, not from when you open it. If someone else has already pressed the button, you see "This site has already been set up." If that was not you, tell whoever looks after the site's setup. If you pressed it yourself and lost the page before saving the secret, add /setup to the end of the address and open it in the same browser, within a day. The page lets you make a new pair, as long as you have not signed in yet. A new pair replaces the first.

Until your first successful sign-in, the browser that pressed the button can make a new pair, and the old pair stops working. After your first sign-in the setup page goes for good, and opening it shows "Not found." You can't make another secret from it.

If the page says "Setup is closed", nobody made the admin secret within the 30 minutes. (After the 30 minutes your site's address shows the ordinary home page. To see this message, add /setup to the end of the address; opening /admin says "Admin sign-in isn't set up.") Ask whoever looks after the site's setup to reopen it, using [If the admin secret is lost](handover.md#if-the-admin-secret-is-lost). If your site was set up with a setup code, the page asks for it instead of showing the button, and a wrong code gives "That setup code isn't right." After a few tries you see "Too many attempts. Try again in" some minutes. If the page says "Setup isn't ready", the setup code is too short, so ask whoever deployed the site.

### The password screen

You will see a page called "Admin sign-in".

1. Open the admin page.
2. Tap the box labelled "Admin secret".
3. Type or paste your admin secret.
4. Tap "Sign in".

You land on the events page. A wrong secret gives "That admin secret isn't right." Too many tries in a row gives "Too many attempts. Try again in" some minutes. Wait, then try again.

The admin secret is long and random. Keep it in a password manager and paste it. Spaces before or after it are ignored.

If you tap an admin link in a chat app and land on the sign-in page, wait a moment. If you are already signed in, it takes you straight on.

### The emailed code

You type your email address and a one-time code is emailed to you. Type the code in to get in.

That screen belongs to a separate sign-in service, not to this app. I can't show you exactly what it looks like.

If no code arrives:

1. Check your junk folder.
2. Ask whoever looks after the site's setup to check that your email address is on the allowed list.

If you see "Sign-in is handled by your organisation's Cloudflare Access login. Open the admin pages from the link you were given.", use the admin link you were given instead of the address you typed.

### How long you stay signed in

With the password screen, you stay signed in for up to 8 hours from the moment you sign in. Using the pages does not add time.

With the emailed code, whoever set up the site chose the length. I can't see it from the code. Ask them if it matters.

When your time runs out, the next thing you tap takes you back to the sign-in page. Sign in again. Anything you had typed but not saved is likely to be lost.

To sign out yourself, go to the events page and tap "Sign out".

### Lost the admin secret

If you saved your recovery code, you can make a new admin secret yourself:

1. Add /recover to the end of your site's address and open it.
2. Type or paste the recovery code and tap "Continue".
3. The page shows a new admin secret and a new recovery code, once. Save both, as in "The first time" above. The old secret and the old recovery code stop working, and anyone signed in with the old secret is signed out.

After 5 wrong tries from the same place you see "Too many attempts. Try again in N minutes." (with a number in place of N). Wait that long and try again. If the page says "Not found", the site has no recovery code (a site set up on an earlier version has none), so ask whoever looks after the site's setup. If you lose the recovery code too, ask them as well: they can find the steps in [handover.md](handover.md#if-the-admin-secret-is-lost), section "If the admin secret is lost".

## 2. Club settings and branding

This part is for the club name, contact details, logo, colours and icons. Tap "Settings" in the row of links at the top of any admin page. Each part has its own save button.

### Club details

1. Tap the "Club name" box and type your club's name. It shows in the page header, the browser tab, calendar entries and the lineup.
2. Fill in "Privacy contact name" and "Privacy contact email".
3. If you want a link to your own site, fill in "Website (optional)". It must start with https://.
4. Tap "Save details".

You should see "Club details saved." If a box has a problem, you see "Not saved. Check the highlighted fields."

The header at the top may keep the old club name until you reload the page.

### Why the privacy contact matters

People booking give the details the booking form asks for (for example a dog's name and a handler's name). The booking form tells them who to contact about those details, and that is the privacy contact. The contact only counts once it has an email address.

If no contact is set, you will see a warning at the top of the booking page when you are signed in. It starts "Admin notice (the people booking can't see this)". Other people do not see it. It has a link to "Settings".

### Logo

1. Tap "Choose a logo".
2. Pick a picture. Use a PNG, JPEG or WebP picture. Other kinds, such as SVG, are refused.
3. Wait for the preview. Your phone shrinks the picture for you to fit within 512 pixels and under 200 KB.
4. Check the preview, then tap "Use this logo".

Nothing is saved until you tap "Use this logo". You should then see "Logo saved."

A picture over 20 MB is refused. Pick a smaller one.

To take the logo away, tap "Remove logo", then "Yes, remove logo". The pages then show only the club name, and the icons go back to a plain clock mark on your main colour.

### App icons and the home screen icon

You do not make the icons yourself. When you save a logo, the page draws the little icons for browser tabs and phone home screens from it, on your main colour. With no logo, the icons are a clock mark in the same colours, and they change when you save new colours or take the logo away.

1. Save a logo.
2. Stay on the page. You see "Updating app icons…".
3. Wait for "App icons updated."

If it says it couldn't update the icons, the logo (or the colours) are still saved. Open the Settings page again and it tries again by itself.

If you leave early, it also tries again next time you open Settings. Until then the icons may still be in your old colour.

Browser tab icons can take a few minutes to change. An icon already on a home screen may keep the old picture. I'm not sure when phones refresh it.

To put the admin page on your phone's home screen:

1. Open the admin page in your phone's browser.
2. Use your browser's Add to Home Screen option.

### Colours

The page offers two colours. "Main colour" is for "Buttons, selected slots and the header band." "Accent colour" is for "Links and outlined buttons."

1. Optionally tap a preset under "Start from a preset". The presets are Ocean, Forest, Berry, Ember, Teal and Slate.
2. Or tap "Main colour" or "Accent colour" to pick your own.
3. Look at the Light and Dark previews. Dark mode lightens your colours for you.
4. Tap "Save colours".

You should see "Colours saved."

To go back to the starting colours, tap "Reset to default colours".

#### The contrast checks

Contrast means how well one colour stands out from another. Text needs to stand out so people can read it.

Under the previews you see either "All contrast checks pass." or a list.

- "These colours can't be saved yet:" means some text would be hard to read. "Save colours" stays switched off. Try a darker main or accent colour.
- "Advice (you can still save):" means your main colour is a bit faint against the page. Buttons may not stand out much. You can still save.

## 3. Creating an event

This part walks through the form for a new event.

1. On the events page, tap "Create event".
2. If you have templates, the form may already be filled in from your default one. Pick a different one, or "No template", under "Template". See [Templates](#4-templates).
3. Fill in the form, using the notes below.
4. Tap "Save event".

You can edit the event afterwards, so a slip is easy to fix.

### The fields

- "Event name". Up to 100 characters.
- "Date". It must be in the future, and not more than two years away.
- "Start time" and "End time". The end must be after the start, so an event can't run past midnight. On the two nights when the clocks change, a time that doesn't exist, or happens twice, is refused with a message.
- "Session length (minutes)". How long each person gets. From 1 to 480.
- "Gap between sessions (minutes)". Time left after each session before the next starts. From 0 to 120. With 20-minute sessions and a 5-minute gap, slots start at 09:00, 09:25, 09:50 and so on.
- "Cost (£)". Type 12 or 12.50. Type 0 if it's free. People then see "Free".
- "Venue postcode". 2 to 10 letters and numbers. People see it as a link to a map.
- "Details (optional)". Up to 2000 characters. People see it on the booking page and after they book. A good place to say how to contact you to change a booking.
- The "Booking form" card: what people are asked when they book. A new event asks for one thing, "Name". See [The booking form](#the-booking-form).
- "Lane name (optional)" and "Places per lane per time". Most events leave these alone: one lane, one place. See [Lanes and places](#lanes-and-places).
- "Share message (optional)". Up to 1000 characters. The wording used when you share this event, with placeholders such as {event} and {date}. Leave it blank to use your default template's message. See [Templates](#4-templates).
- "Listed on the home page". Ticked by default. See below.

An event can have at most 500 slots.

### Schedule preview

Once the date, times, session length and gap are filled in, a "Schedule preview" appears. It says how many slots there are and lists the start times. With more than one lane or place per time, the "Lanes" card under the breaks also adds a line such as "12 times × 3 lanes × 2 places = 72 places". Check it before you save. Until then it says "Fill in the highlighted fields to see the schedule."

### Breaks

A break is a time with no slots, such as lunch.

1. Tap "Add break".
2. Fill in "Start" and "End".
3. Optionally fill in "Name (optional)". The box shows Lunch as an example.
4. Tap "Remove" on a break to take it out.

A break must sit inside the event. You can add up to 20.

What a break does to the slots:

- A session that would run into the break is left out.
- The time before the break is simply unused.
- Sessions start again when the break ends.

### Near-miss suggestions

Sometimes a break cuts off a session by only a few minutes. The page notices and offers a fix.

You see a question like "Move Lunch to 12:10–13:10 to keep the 11:50 session?" It appears when a session would be dropped because it overlaps the start of a break by 10 minutes or less. The suggestion moves the break later, with the same length, so the session fits.

It is only offered if the moved break would not clash with another break or run past the end.

You choose:

- "Move break" puts the new break times into the form and updates the preview.
- "Keep as it is" hides the suggestion.

Neither saves anything. You can also ignore the suggestion.

### Listed on the home page

The home page lists upcoming events. Untick "Listed on the home page" and the event stays off that list. Its link still works, and anyone with the link can still book. Use this for an event you only want to share with certain people.

Only events that have not started yet are on the home page, whether or not they are listed. Archived events are not on it either.

An event that is not listed shows a "Not listed" label in your admin pages.

### After you save

You see "Event created", with the event name and the sharing tools described in [Sharing to WhatsApp](#5-sharing-to-whatsapp).

On the events page, the event now appears under "Upcoming events". It shows a "Bookings open" label and how many slots are booked.

## 4. Templates

A template is a saved set of answers for the event form, so you don't type the same details for every event. This part covers making them, how the form uses them, and the share message.

### What a template holds

- A name (up to 60 characters, and no two templates may have the same name, ignoring capital letters).
- "Details (optional)", "Venue postcode" and "Cost (£)", as in the event form.
- "Start time", "End time", "Session length (minutes)" and "Gap between sessions (minutes)".
- Breaks, each with a start, an end and an optional name.
- The booking form: its fields and the identity limit, as in [The booking form](#the-booking-form).
- Lanes (names only) and the places per lane per time, as in [Lanes and places](#lanes-and-places).
- A share message (see below).

It holds no event name and no date. You choose those for each event. You can have at most 20 templates.

### Making a template

1. Tap "Templates" in the row of links at the top.
2. Tap "New template". At 20 templates the button is greyed out, with a note saying why. Delete one to make room.
3. Fill in the form. It uses the same boxes and rules as the event form (including the "Booking form" card, but without the lock described there, since a template has no bookings), so see [Creating an event](#3-creating-an-event). Tap "Add break" for breaks.
4. Tap "Create template". You go back to the list, which says "Created" and the name.

A box that the server doesn't accept shows its message under it, and the page moves to the first one. For breaks, the message appears under the break it is about.

The list shows each template's name, "Default" on the default one, and a line such as "09:00–16:00, 20 min sessions, £12.00". A template whose booking form isn't the single "Name" field has a line such as "Fields: Dog, Handler", and one with more than one lane or place per time has a line such as "3 lanes × 2 places". Each has "Edit" and "Delete", and every template except the default has "Make default".

### The default template

One template is the default. The first one you make becomes the default. To make another one the default, tap "Make default" on it, or tick "Use as the default for new events" when you make or edit it. There is always one default while you have any template. On the default template that box is ticked and greyed out, with the note "To change the default, make another template the default". If you delete the default, the oldest remaining template becomes the default.

The default is used in two ways: it fills in the create-event form, and its share message is used for events that have no message of their own.

### Using a template when you create an event

On the create-event page, a "Template" box at the top lists "No template" and each of your templates, with "(default)" after the default one.

- When the page opens, your default template fills the form in by itself, but only if you haven't typed anything by then. If you had already started, nothing is replaced and the box stays on "No template".
- Choosing a template fills in the details, postcode, cost, start and end times, session length, gap, breaks, the booking form (fields and identity limit), lane names, places per lane and share message. It replaces what is in those boxes now, including anything you typed there. It never changes the event name, the date or "Listed on the home page". The page says "Filled in from the template" and its name, and the schedule preview updates.
- Choosing "No template" empties exactly those boxes, removes the breaks and goes back to the single "Name" field, one unnamed lane and one place. It says "Cleared the template fields."
- You can still change anything afterwards.

If the templates can't be loaded, the box is hidden and the page says so; the form still works by hand. If you have no templates yet, there is a link "Create a template to save time".

### Events keep their own copy

An event stores its own copy of what it was made with. Changing or deleting a template later never changes events you have already made. To change an event's wording, edit the event.

### The share message

The share message is the text that "Share", "Copy message" and the "Event created" page build for an event. You can write one on a template and on each event ("Share message (optional)", on both the create and the edit page). Placeholders in curly brackets are replaced with the event's details each time someone shares:

| Placeholder | Becomes |
| --- | --- |
| {event} | The event name |
| {date} | The date, for example Saturday 13 June 2026 |
| {start} | The start time, for example 09:00 |
| {end} | The end time, for example 16:00 |
| {cost} | The cost, for example £12.00, or Free |
| {postcode} | The venue postcode |
| {details} | The event's details text |
| {lanes} | The lane names, separated by commas. Blank for an event with one unnamed lane |
| {club} | Your club name |
| {link} | The booking link |

Which message is used when you share an event: the event's own message if it has one; otherwise the default template's message; otherwise the built-in wording described under [The message](#the-message).

The values go in as they are. If an event's name contains something that looks like a placeholder, it appears as typed and isn't filled in again. A line with a placeholder that comes out empty (a blank club name, say) is left out. Other lines are kept as you typed them.

- **Unknown placeholders** are left exactly as typed. Typing {Event} with a capital letter, or {name}, doesn't work: it appears in the message as those letters. The template form lists them under the preview, as "These will appear as typed:".
- **Without {link}** the booking link is added on its own last line, so the message always has it. With {link} you choose where it goes. The built-in message ends with the link, and I haven't checked whether WhatsApp shows its preview card when the link is somewhere else.

### The preview

Under the share message, "Preview" shows the message as it would be shared, and updates as you type. It uses a sample event called Spring Scent Trial on a Saturday in January 2027, with this form's own details, postcode, cost, times and your club name, and a sample link ending /e/example. A cost, times or postcode left blank show an example instead. If the share message is blank, the preview shows the built-in wording and says so. Remember that an event made from a template with a blank message is shared with the default template's message, or the built-in one if that is blank too.

The preview is plain text. Nothing you type is ever treated as page markup.

### Changing and deleting a template

- Tap "Edit", change the boxes and tap "Save changes".
- Tap "Delete" and a panel asks you to confirm. It names the template and says "Events already made from it are not changed." Tap "Delete template" to go ahead or "Cancel" to keep it.

I haven't tried the Templates page or the template box on a real phone. The tests cover it in a simulated browser only: the layout, the keyboard that appears and the phone's own time and date boxes are unchecked.

## 5. Sharing to WhatsApp

This part is for getting the booking link to your members.

### The Share button

Every upcoming event has a "Share" button. You find it in three places:

- On the events page, on each event under "Upcoming events".
- On the event's schedule page, under the date. It is not there for an archived event.
- On the "Event created" page, right after you save.

Past and archived events have no Share button. Their booking links are closed.

Next to "Share" there is always a "Copy message" button. Tap it, you see "Copied", then paste the message into WhatsApp Web or any other app. If your browser won't let the page copy, the text appears in a box with it already selected. Copy it by hand.

**On a phone or tablet**, tap "Share". Your device's own share sheet opens with the message ready. Pick WhatsApp, then pick one chat or several. You can pick any other app in the sheet too. If you close the sheet without choosing, nothing happens.

**On a computer**, some browsers also have a share sheet, and then "Share" works the same way, with "Copy message" beside it. Where there is none, you see "Copy message" and, on the schedule page, "Copy link" instead. (On the events page the event already has "Copy booking link".)

If "Share" fails, a note says so, and on the schedule page "Copy link" appears too.

### The message

The message is made fresh every time you tap. It uses the event's details as they are now, so if you edit the event and share again, the new details are used. Nothing is saved in the button.

Unless the event or your default template has its own wording (see [Templates](#4-templates)), it has these lines:

1. Your club name, if you have set one.
2. The event name.
3. The date and time range.
4. The venue postcode.
5. The cost.
6. "Book your slot:", then the booking link on its own last line.

The details text is not in it. The link is always on a line by itself at the end, so WhatsApp can show a preview card for it.

If a line would be empty, for example you have not set a club name, it is left out.

### The "Event created" page

After you save, this page also has:

1. A box labelled "Booking link", with "Copy link".
2. A box labelled "WhatsApp message" with the same text that "Share" sends, and "Copy message".
3. "Open in WhatsApp", which opens WhatsApp with the message ready.

"Share" appears at the top of the page where the browser has a share sheet. You can still copy the link later: on the events page, tap "Copy booking link" on the event.

I have not tried "Share", "Open in WhatsApp" or any of the Copy buttons on a real phone. The tests check the behaviour in a simulated browser only. If "Share" doesn't work for you, use "Copy message".

To make another event, tap "Create another". To leave, tap "Back to events".

### The preview card

When you paste an event's booking link into WhatsApp, or a similar app, it may show a small preview card. For an event, the card shows the event name and its date, then your club name, the venue postcode and the cost, with the club's icon. A link to the home page shows the club's name. It is made from what anyone can already see on the booking page, so the details text and the names of people booking are never in it.

I haven't seen this on a real phone. WhatsApp remembers the preview it made the first time a link was shared. If you rename or change an event after sharing its link, people may keep seeing the old card for a while, and I don't know how long. The message you share already has the event's name, date, postcode and cost in it, so the card may repeat them.

### What people booking see

1. They open your link and see the event name, date, time, venue and cost.
2. Under "Pick a time" they see the free slots. Slots already taken are hidden. Slots that have started show "Started".
3. They tap a time.
4. They fill in the booking form: one box for each field of the event, titled with the field's label ("Dog" and "Handler" for an event made before the fields could be changed; see [The booking form](#the-booking-form)). A field that isn't required says "(optional)".
5. They tap the confirm button, which says "Confirm booking for" and the time.

With one lane and one place per time, that is all they see. With more places or lanes the page changes a little:

- **One lane with several places:** the same grid of times, each with how many places are left under it ("2 left", "1 left"), and the count above the grid says "places left" instead of "slots left".
- **One lane with a name:** the same grid, with the lane's name in the form heading ("Booking 10:00 · Main ring") and on the confirm button.
- **Two or more lanes:** each time is a card with a button for every lane, showing the lane's name and "2 left", "1 left" or "Full". A full lane can't be tapped. A time with no free place in any lane is hidden, and a time that has started shows "Started". The person taps the lane they want, and the form heading and confirm button name the time and the lane ("Booking 10:00 · Ring 1"). If someone takes the last place in that lane first, they see "That slot's just gone." with the up-to-date list.

They then see "You're booked in", with "Copy booking" and "Add to calendar". When the lane has a name, the confirmation has a row for each value they gave (labelled with the field's label), then a "Lane" row, and the copied text has a line for each value, and has a "Lane:" line after the values (before the venue). The page tells them to keep the details, because there is no way to look a booking up again.

If you change the event while someone is booking (a lane is removed or added, or a question on the form is added, removed or renamed), their next attempt shows "The event was just changed. The times below are up to date; choose again." The page picks nothing for them, shows the lanes and times as they are now, and, if the form changed, shows the new form with what they had typed kept in any question that is still the same.

People can't change or cancel a booking online. The page tells them to contact the organiser. You do it for them, as in the next section.

## 6. Fixing bookings

This part is for adding, moving, swapping and removing bookings yourself.

1. On the events page, tap "Schedule" on the event.
2. Find the time you want. Each row shows a time and either "Free" or who booked: the first value of the booking, and the others in brackets ("Rex (Sam Smith)"; just "Sam" if the form has one field).

Breaks show too, in time order.

With one lane and one place per time, that is the whole page. If the lane has a name, the name is shown in each row. With more places or lanes, each time is a heading with how many places are free ("6 free", or "Full"). Under it there is a row for each booking, with the lane name when the lanes have names, who booked, and "Move", "Swap" and "Clear". For each lane that still has room there is one row saying how many places are free, with "Add booking". Everything below works the same way: the buttons are just on the row you mean.

After each action the page reloads the list so you see what is really saved. A line at the top says what happened.

### Add a booking for someone

1. On a free row, tap "Add booking".
2. Fill in the boxes, one for each field of the booking form and titled with its label ("Dog" and "Handler", say). A field that isn't required says "(optional)".
3. Tap "Add booking".

A box the server doesn't accept shows its message under it, and the page moves to the first one.

### Move a booking

1. On the booking, tap "Move".
2. Under "New slot", tap "Choose…" and pick a free time.
3. Tap "Move booking".

If nothing is free you see "There are no free slots to move it to."

With more places or lanes the box says "New place" and lists every time and lane that has room, such as "10:30 · Ring 2 (1 left)". The booking's own place is not listed, but the same time in another lane is, so you can move someone to another ring without changing the time. If there is no room anywhere you see "There are no free places to move it to."

### Swap two bookings

1. On one of the bookings, tap "Swap".
2. Under "Swap with", pick the other booking.
3. Tap "Swap bookings".

Each person keeps their own booking. They just trade times. With lanes the choices name the time and lane ("10:30 · Ring 2: Rex (Sam)"), and the two bookings trade lane, time and place. The page sends the lane each booking was in when you opened the schedule, so if either has moved to another lane since, the swap is refused, nothing changes, and the schedule refreshes ("That changed while you were working.").

### Remove a booking

1. On the booking, tap "Clear".
2. Read "Clear this booking?"
3. Tap "Clear booking".

With lanes the question names the time and the lane. The person is not told. The page says "They won't be told. You need to let them know."

### Rules and clashes

- You can add or move bookings after bookings have closed, and into slots that have already started. This is meant for sorting out the day itself.
- A slot holds one booking, for an event with one lane and one place per time. If it is taken, you see "That slot is already taken by" and whoever holds it. The list refreshes. With more lanes or places, a lane that is full says, for example, "Ring 1 at 10:30 is full." and the list refreshes. See [Lanes and places](#lanes-and-places).
- One identity (the fields that identify a booking: the dog and handler together, for the Dog and Handler form) can only have as many bookings as the event's limit, which is 1 unless it has been raised. Capital letters, extra spaces and hidden characters do not make a value different. If they already have one, you are told which time.
- If someone else changed things while you were working, you see "That changed while you were working. The schedule has been refreshed."
- Names have the same rules as when people book. See [If something looks wrong](#11-if-something-looks-wrong).

### Bookings with no slot

If an edit leaves a booking on a time that is no longer a slot, a list called "Not in the schedule" appears. The page says "Move them to a free slot or clear them." These bookings have "Move" and "Clear" only.

## 7. Editing an event

This part covers changing an event, and what you are warned about when bookings would be removed.

1. On the events page, tap "Edit" on the event. On a past event, open "Schedule" and tap "Edit event".
2. Change what you need. The form is filled in for you.
3. Tap "Save changes".

You can change everything on the creation form. You can also edit an event that has already started.

### Changes that are safe

Name, cost, venue postcode, details and "Listed on the home page" do not touch bookings. Changing "Listed on the home page" gives no warning and does nothing to bookings. It only decides whether the event shows on the home page.

### Changes that can remove bookings

Date, times, session length, gap and breaks change the slots. A booking is affected when its start time is no longer one of the event's slots. Removing a lane, or lowering the places per lane, can affect bookings too: see [Lanes and places](#lanes-and-places).

The page warns you while you edit. Under "Schedule preview" you see a count, such as "1 booking is on slots this change removes:". Then you see each person, like "10:05 — Rex — Sam Smith" (with the lane after the time when it has a name: "10:05 — Ring 1 — Rex — Sam Smith"). When a lane you removed or lowered places is the reason, the count says so ("1 booking is in a lane you removed:", "1 booking is over the places you set for each lane:"). It adds "You'll be asked to confirm before anything is removed."

When you tap "Save changes" with affected bookings, nothing is saved yet. You see a screen headed "Saving will remove" a number of bookings, "Tell these people to rebook:", with the list.

- Tap "Remove 1 booking and save" to go ahead. The wording shows the real number.
- Tap "Cancel" to go back. Nothing has changed.

If a new booking appears while you are editing, you see "Another booking has appeared since you checked, so please check the list again."

### Lanes and places

An event has one or more **lanes** (rings that run at the same time, up to 10) and a number of **places** per lane at each time (1 to 50). A new event has one unnamed lane with one place, which is how every event worked before. An event can have at most 2000 places in all: times, multiplied by lanes, multiplied by places per lane.

**Setting them.** On the create and edit pages, the "Lanes" card sits under the breaks. It has one row for each lane.

- With one lane, "Lane name (optional)" can stay blank ("Leave blank if you only have one"). Give it a name if you like, such as "Main ring".
- Tap "Add lane" for another. From two lanes up, every lane needs a name, and no two may have the same name (capital letters, extra spaces and look-alike forms such as a full-width letter or a circled digit don't make a name different). A lane name follows the same rules as a booking's values: it needs at least one letter or number, and hidden marks, private-use characters and the blank braille character are refused. A lane name saved earlier that breaks these rules can still be saved unchanged, but not typed in again. Each lane has "Remove", except that the last lane can't be removed. You can have up to 10, and "Add lane" greys out there.
- "Places per lane per time" is how many bookings one lane takes at the same time. It stays at 1 for one booking per time.
- Under it you see a line such as "12 times × 3 lanes × 2 places = 72 places" once the schedule is complete. It is left out for one lane with one place. An event with more than 2000 places is refused, with a message under the lanes or the places.

A name or number the server doesn't accept shows its message under that lane (or under "Places per lane per time"), and the page moves to the first one.

**Editing.** A lane you rename keeps its bookings: lanes are matched behind the scenes, not by name. A lane you remove is gone, and a lane you add is new. Adding a booking goes to the lowest free place in the lane you chose. If someone else saved the lanes, the places or the booking form (its fields or the identity limit) after you opened the page, your save of any of those is refused, and nothing is written, with the message "The lanes, places or booking form of this event were changed by someone else. Reload the page to see them, then make your change again." The message has a Reload button next to it: it fetches the event again and shows the form as it is saved now (what you had typed is not kept), so you can look at what they did and make your change again. The edit page sends the revision it was opened at with any such save, which is how the server knows. A save that changes none of those (only the name, the times or the cost, say) is not refused and overwrites the same fields of the other admin's save, as it always has.

**When bookings don't fit.** Saving an edit that would leave bookings with nowhere to go works as in "Changes that can remove bookings": nothing is saved until you confirm the list. A booking is on that list when its time is no longer a slot, when its lane is removed, or when there are more bookings in a lane at a time than the new number of places. The people who booked first keep their places and the latest bookings are listed. The list and the confirmation screen say why ("in a lane you removed", "over the places you set for each lane"), and each person's line names their lane when it has a name. The bookings that stay are renumbered, so the places always count 1, 2, 3 and so on. After saving, the "Removed bookings" message lists the same lines.

**Templates.** A template has the same "Lanes" card (names only, since a template has no bookings) and "Places per lane per time". Choosing the template on the create page copies them into the form, and the event keeps its own copy.

**The schedule page.** See [Fixing bookings](#6-fixing-bookings): each time lists its bookings by lane, with "Add booking" for each lane that has room, and Move, Swap and Clear name the lane.

**The events list.** An event with more or fewer places than times shows "n of P places booked" instead of "n of m slots booked".

What the outputs show for lanes and places:

- **The lineup** has one line per place, showing only the fields that identify a booking. An event with one unnamed lane reads as it always did ("10:00 — Rex — Sam", "10:00 — free"; with several places, the bookings first, then a "free" line for each free place). Otherwise each line names the lane after the time ("10:00 Ring 1 — Rex — Sam", "10:00 Ring 1 — free"), in time order, then lane order, then place. A single lane that has a name is named too.
- **The CSV** gets a "Lane" column after "Time", but only when the event has a named lane. The rows are in time order, then lane order, then place.
- **The calendar entry** (.ics) a booker adds says "Slot: 10:00–10:30, Ring 1" when the event has a named lane, and is otherwise unchanged. The entry's title, location and identity are unchanged.
- **The share message** has a {lanes} placeholder: the lane names separated by commas. It is blank for an event with one unnamed lane, so a line holding only {lanes} is left out. Share fills it in from the events list, the schedule page and the "Event created" page.

### The booking form

The "Booking form" card on the create and edit pages (and on the template form) sets what people are asked when they book. It sits under the breaks, above "Lanes". An event has one to four **fields**. Each field has:

- **Label**. Up to 40 characters, and no two fields may have the same label (capital letters, extra spaces and look-alike forms don't make a label different). It needs at least one letter or number, and hidden marks, private-use characters and the blank braille character are refused, as for lane names (a label saved earlier that breaks these rules can still be saved unchanged). People see it as the title of the box ("Dog", "Rider's name", "Phone").
- **Required**. Ticked, the box has to be filled in. Unticked, it is marked "(optional)" and can be left empty.
- **Max length**. The most characters the box takes, 1 to 80 (80 by default).
- **Identifies a booking**. Ticked on the fields that tell one booking from another (see below).

Tap "Add field" for another (up to four; the button greys out there) and "Remove" on a field to take it out (the last field can't be removed). The fields are numbered "Field 1" and so on, in the order people see them.

**Required and identifying fields.** The first field is always required, and so is every field that identifies a booking: their "Required" box is ticked and greyed out, with a note saying why. At least one field must identify a booking; if none does, the save is refused with "At least one field must identify a booking."

**The identity limit.** Under the fields is a question made from the labels of the identifying fields, such as "How many bookings can one Dog + Handler make?" (it changes as you type the labels and tick the boxes). The answer is the **identity limit**, 1 to 20 and 1 by default: how many bookings the same identity may hold in the event. An identity is the values of the identifying fields together, and two values are the same when they differ only in capital letters, extra spaces or hidden characters. The other fields can differ. With a limit of 1 the same dog and handler can book one time only; with 3, up to three times. A booker who is over the limit is told "That dog and handler already have a booking for this event." (with the field names of your form). If you lower the limit below what an identity already holds, its bookings stay, and it can't book again until it holds fewer than the new limit. **With a limit above 1, the app does not stop one person taking two places at the same time:** the same identity may hold two places in the same time (in another lane, or another place in the same lane), because the limit counts bookings, not times.

**New events and templates.** A new event with no template asks for one required field, "Name", that identifies the booking, with a limit of 1. Choosing a template copies its fields and limit; "No template" goes back to "Name". Events and templates that existed before the fields could be changed have "Dog" and "Handler", both required, 80 characters, both identifying the booking, and their bookings are unchanged.

**Once an event has bookings,** you can no longer add or remove fields or change which ones identify a booking, because the stored bookings and their calendar entries depend on that. On the edit page "Add field", "Remove" and the "Identifies a booking" boxes are greyed out, with the note "Bookings exist, so you can't add or remove fields or change which ones identify a booking. You can still rename them and change the other settings." You can still rename a field, change which fields are required (except the ones that must be), change a longest length, and change the identity limit. If a booking arrives while you are editing and you have already added or removed a field or changed an identifying box, the save is refused with a message saying so, and the whole "Booking form" card is put back as the page loaded it: its fields, labels, required boxes, longest values and the identity limit. The message says "Your changes to the booking form were discarded", and the card shows the server's reason. Your changes to the rest of the form are kept. Make the changes you still want, such as a new label, and save again. To change the shape of the form of an event that has bookings, you would have to clear its bookings first. A booking made at the very moment you change what is required or a longest value is refused and tried again against the new form.

**What people see.** Each field's label is the title of its box, with "(optional)" after it when it isn't required. A required box left empty says "Dog is required." and the other messages start with the same bare label ("Dog must be at most 80 characters."). An optional field left empty is left out of the confirmation and the calendar entry, and its cell in the CSV is empty. The lineup shows only the fields that identify a booking, whether or not the others are filled in (see [The lineup](#8-the-lineup)). The privacy notice names the labels.

**Examples.** Each is a set of fields, lanes and places; adapt the labels to your own club.

| Event | Fields (identity in bold) | Limit | Lanes and places |
| --- | --- | --- | --- |
| Dog sports trial | **Dog**, **Handler**, Phone (optional) | 1 | one lane per ring ("Ring 1", "Ring 2"), 1 place |
| Riding lesson or clinic | **Rider**, **Pony**, Phone (optional) | 2 (two lessons each) | one lane per arena, 1 place |
| Tennis or badminton courts | **Member name**, Member number | 3 (three slots a day) | one lane per court ("Court 1" to "Court 4"), 1 place |
| Golf tee times | **Player 1**, Player 2 (optional), Player 3 (optional), Player 4 (optional) | 1 | one lane per starting tee ("1st tee", "10th tee"), 1 place |
| Parents' evening | **Parent**, **Child**, Class | 5 (an appointment with up to five teachers) | one lane per teacher, 1 place |

For the golf example one booking is a whole group: only Player 1 identifies it, so one person can't hold two tee times, and the other players are optional and appear on the admin pages, in the CSV and in the booker's confirmation when filled in (the pasted lineup shows only Player 1). The limit counts across the whole event, so the parents' evening needs a limit of more than 1 for a parent to see several teachers. Tick "Identifies a booking" on every field you need to tell bookings apart, and no more: ticking Phone, say, would let the same dog and handler book twice with different phone numbers.

**Checking it.** The lineup, the CSV and the confirmation use your labels: the lineup joins the values of the fields that identify a booking with " — " ("10:00 — Rex — Sam"), the CSV has a column headed by each label, and the confirmation has a row for each value the booker gave.

### After saving

You see "Saved." If bookings were removed, you also see "Removed bookings: tell these people to rebook". The people are not told for you.

1. Tap "Copy list". It copies lines like "Please rebook: 10:05 — Rex — Sam Smith". Each line has the time (and the lane, when it has a name) and only the values of the fields that identify a booking, so a phone number or a note a person gave is not in the text you paste into the chat.
2. Paste it into your chat.

There are also "Back to events" and "Open the booking page" buttons.

## 8. The lineup

This part is for sharing the running order with names.

1. On the events page, tap "Schedule" on the event.
2. Tap "Copy lineup". You see "Copied".

If it can't copy, a box appears with the text. Copy it from there.

The text looks like this:

1. Your club name, if set.
2. The event name.
3. The date, then a dot, then the venue postcode.
4. A blank line.
5. One line per place, in time order. A booked place shows the time and the value of each field that identifies the booking, in the form's order (the dog and the handler, for the Dog and Handler form). Other fields, such as an optional phone number or a note, are not in the lineup. A free place shows the time and "free". With a named lane (or two or more lanes) each line also names the lane after the time, and the lines at one time go by lane order, then place. See [Lanes and places](#lanes-and-places).
6. Breaks show where they fall, with their start and end times and their name. An unnamed break shows as "Break".

Paste it into a group chat such as WhatsApp. The booking form's usual privacy note tells people that the running order, with names, may be shared with other people taking part. Only the fields that identify a booking go into the lineup, so what you collect in other fields (a phone number, medical notes) is not pasted into the chat by mistake. Those appear on the admin pages, in the CSV download and in the booker's own confirmation and calendar file.

Names appear as typed. If a name has star, underscore or tilde characters, WhatsApp may turn part of the message bold, italic or struck through.

Bookings that are not in the schedule are left out.

## 9. Exporting bookings

This part gives you a spreadsheet of one event's bookings.

1. On the events page, tap "Schedule" on the event.
2. Tap "Download CSV".

You get a file ending in -bookings.csv. Open it in Excel, Google Sheets or Numbers.

It has a "Time" column, one column for each field of the booking form headed by its label, and "Booked at": "Time", "Dog", "Handler" and "Booked at" for the Dog and Handler form. A "Lane" column comes after "Time" when the event has a named lane. Times are London time. It lists the bookings only, in time order (then lane order, then place). It does not include free slots, the event settings or breaks.

Some names may start with a mark like an apostrophe. That happens when a name begins with a symbol such as =, +, - or @. It is on purpose. It stops a spreadsheet from treating the name as an instruction. The name itself is unchanged.

The file holds people's names. Keep it private. Do not post it in a chat or email it around. Delete it when you have finished.

## 10. Archiving, deleting and clearing out old events

This part is for tidying up. Save an export first if you may need the names later.

### Archive

On the events page, tap "Archive" on an event.

- The event leaves "Upcoming events" and moves to the "Archived" part of the page.
- It is off the home page.
- Its booking link still opens, but it shows "Bookings closed".
- All bookings are kept.

Archived events show only "Unarchive" and "Delete…". There is no "Schedule" or "Edit" there. To use them again, tap "Unarchive".

### Delete one event

Deleting is permanent. The event and all its bookings go. They can't be brought back. Download the CSV first if you may need the names.

1. Tap "Delete…" on the event.
2. Read the warning. It says how many bookings will go.
3. Under "Type the event name to confirm", type the name exactly as shown.
4. Tap "Delete event".

You should see "Deleted" with the event name and the number of bookings. Anyone using the old link is told "We couldn't find that event. Check the link you were sent."

### Clear out past events

On the events page, tap "Past" to open it. It lists events that have ended and are not archived.

1. Tick the events you want to remove. Or tick "Select all".
2. Tap "Delete selected" and the number.
3. Read the list and the warning.
4. Type DELETE under "Type DELETE to confirm".
5. Tap "Delete events".

You see how many events and bookings went. If something could not be deleted, it is listed with the reason.

Only the 100 most recent past events are shown. Delete some to see more.

Archived events are not part of this. This is a known limit. Delete archived events one at a time with "Delete…". Nothing reminds you. If you plan to clear out in bulk, leave old events in "Past" rather than archiving them.

### Keep it tidy

The booking form's usual privacy note says details are kept until an organiser deletes the event. Nothing is deleted automatically. So delete old events once you no longer need them. Deleting removes the bookings from the live database, but Cloudflare keeps backups of earlier states (D1 "Time Travel", 7 days on the free plan and 30 on paid), so a deleted booking can still exist there until that period ends. The app can't remove it from the backups.

## 11. If something looks wrong

This part lists what you might see and what to do.

- **The page sends you to the sign-in page.** You were signed out. Sign in again. See [Signing in](#1-signing-in).
- **You see "Admin sign-in isn't set up."** The admin sign-in is missing a setting on the site. Contact whoever looks after the site's setup. On a brand new site, opening an admin page should take you to the setup page instead: see [Signing in](#1-signing-in).
- **A booking looks wrong.** Open "Schedule" for the event. Use "Move", "Swap", "Clear" or "Add booking". See [Fixing bookings](#6-fixing-bookings).
- **A name was refused.** Messages like "Dog can't contain invisible or direction-changing characters." (the message starts with the field's label) mean the value has a hidden mark in it. This happens with text pasted from elsewhere. It also happens with some emoji that are joined together with an invisible joiner. Some names in certain scripts need a joiner and are refused too. Retype the name by hand. For an emoji, pick a single plain one. The same rule applies to event names, break names, details, the club name and the contact details. An event or settings text saved earlier that has such a character in it can still be saved unchanged, but if you change that text, type it again as plain text. Every booking value also needs at least one letter or number in it ("Dog must contain at least one letter or number."), so a value made only of an emoji or symbols is refused; add a letter, for example "Rex 🐶".
- **The logo won't upload.** Use a PNG, JPEG or WebP picture under 20 MB. A message says if it is the wrong type, too big, or can't be read. Try a simpler picture.
- **The icons didn't update.** Open the Settings page again and wait for "App icons updated."
- **An event isn't on the home page.** Edit it and check that "Listed on the home page" is ticked. The home page also only shows events that have not started, and not archived ones.
- **The booking page says "Bookings for this event are closed."** Bookings close when the event starts, unless the people who set up the site chose another closing time. They can set it earlier or later. An archived event is closed too. A session that has started shows "Started" and can't be picked. You can still add the booking yourself under "Schedule". See [Fixing bookings](#6-fixing-bookings). If it is archived, tap "Unarchive".
- **Anything else, or the site won't load.** Contact whoever looks after the site's setup. The steps they follow are in [handover.md](handover.md).
