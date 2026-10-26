# Visual anchors (C10, absolute scale)

Fixed for the whole study. All three show the same seeded screen (`seed/seed.mjs` default stage, product "Hex bolt M8,
zinc" detail at checkpoint 5, 1280 px, signed in as the admin) of the reference implementation
(regenerate with `tools/anchors.mjs`):

- `5.png` the reference as built: clear hierarchy, consistent spacing, readable tables, grouped stock figures.
- `3.png` the same markup with the styling flattened (serif system font, no color or depth, boxed controls):
  consistent and usable but plain.
- `0.png` the same markup with every stylesheet removed: browser defaults, no layout.
