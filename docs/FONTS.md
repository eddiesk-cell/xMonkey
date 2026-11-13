# Fonts

xMonkey uses the four Anthropic variable fonts that ship inside Claude Desktop
(`anthropic-serif`, `anthropic-sans`, `anthropic-sans-display`,
`anthropic-mono`, weights 300–800). That is what makes the interface typography
match rather than approximate.

**These files are Anthropic's intellectual property and are not committed to this
repository.** `app/assets/fonts/` is git-ignored.

## Getting them (local use only)

If you have Claude Desktop installed on macOS, they are inside its renderer
bundle. From a checkout of this repo:

```bash
cd .rea/extracted-ion/assets/v1   # after unpacking ion-dist.asar, see docs/EVIDENCE.md
D=../../../app/assets/fonts && mkdir -p "$D"
cp c66fc489e-2VcCjn5t.woff2 "$D/anthropic-serif.woff2"
cp cc410af59-Dcb-9NUS.woff2 "$D/anthropic-serif-italic.woff2"
cp cb48c413e-yAna2Le1.woff2 "$D/anthropic-sans.woff2"
cp c9d3a3a49-CJtkx3-S.woff2 "$D/anthropic-sans-italic.woff2"
cp c6064a516-Mpj_akWA.woff2 "$D/anthropic-sans-display.woff2"
cp c5dbe0935-CQcSkHaI.woff2 "$D/anthropic-mono.woff2"
```

## Without them

The CSS falls back cleanly to system faces:

```css
--serif: "anthropic-serif", ui-serif, Georgia, "Times New Roman", serif;
--sans:  "anthropic-sans", ui-sans-serif, -apple-system, system-ui, sans-serif;
```

The layout, palette and metrics still match; only the letterforms differ. The
build script warns when the font directory is empty.
