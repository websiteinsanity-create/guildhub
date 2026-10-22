# Guild Hall 1.42.1

Small hotfix, found in a real server log.

## Fixed: Admin > Discord could throw when Discord answered with something that is not a list

When the Discord settings screen asked Discord for the server's channels and roles, Discord (or something
between the server and Discord) occasionally answered "OK" but with a body that was not a list - for
example an empty or non-JSON reply. Guild Hall then tried to treat it as a list and failed with
`TypeError: (r.data || []).filter is not a function`, so the officer got a plain server error instead of
the settings screen.

Channels and roles now treat such an answer like any other Discord problem: the screen loads and shows
"Discord sent back something unexpected ... Try again in a moment." where the list would be. Nothing else
changes; this error never stopped the server itself.

## Verified

- The full test suite passes (see below).
