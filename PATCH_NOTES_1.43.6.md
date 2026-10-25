# Guild Hall 1.43.6

Gear Thread screenshots (V30), on top of 1.43.5 (skill cores). Frontend only - no server or data changes.

## Changed

- **Screenshots open inside the page** instead of a new browser tab, also in the Coach folder. The image first fits the
  window; **Actual size** shows it at full resolution in a scrollable area, **Fit to screen** goes back.
  Close with the Close button, Escape or a click outside. Questlog and other links still open normally.
- **Paste a screenshot**: copy an image, open the Gear Thread, pick the topic and press Ctrl+V (Cmd+V on Mac) outside
  a text field to upload it to that topic (it replaces the existing one, like the file picker). You can also paste inside
  the Upload/Replace dialog. In the Coach folder composer a pasted image is attached to the draft and only
  published when you press Post. Normal text pasting is untouched.
- Upload hardening: only PNG, JPEG, GIF and WebP up to 6 MB, duplicate pastes are ignored, a dialog that was closed or a
  build that was switched can't upload into the wrong place, and a failed upload keeps the dialog open to retry.

## Previously (1.43.5)

Skill cores catalog, shared Owned collection and per-build Active slots; gear thread layout alignment fix.

## Updating

Replace the files with this package (keep your own `data/` folder) and restart.
