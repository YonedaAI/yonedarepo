# Community events

A small published website fixture for the Context usage pilot. This is synthetic evaluation data.

Keep the static site in `public/`. Its JavaScript module `public/events.mjs` exports
`filterEvents(events, query, now)` and `rsvp(event, identity, storage)`. The browser uses these exports.
`events` contain `{id, title, category, startsAt, capacity, attendees}`; `now` is an ISO timestamp.
RSVP returns `{ok, message}`. Keep the API stable so later agents can continue the project.
