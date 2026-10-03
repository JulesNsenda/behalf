# Brand assets

Not served by the app. Use them for external listings.

- `behalf-logo-512.png`: the GitHub OAuth app logo. It is 512×512 PNG. GitHub wants PNG, JPG or GIF under 1 MB and at least 200×200, and shows it inside a circular badge. The background is full-bleed (no rounded corners), so the circle crop is clean. Set the badge background colour to `#16191E`.
- `behalf-logo-512.svg`: its source. The site favicon is `web/ui/logo.svg`. This version has square corners for the circle crop, and one dash centred in each gap, because at large sizes the favicon's dashed line leaves a stray sliver beside the orange dot.

To regenerate the PNG, render the SVG at 512×512, for example with headless Chrome: `--headless=new --window-size=512,512 --screenshot`.
