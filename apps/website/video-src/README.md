# Website videos

Two kinds of video, on purpose:

- **For the website** — the product fills the picture, nothing else, because the
  page around it already has the headline and the copy:
  - `tour.html` → `public/media/tour.mp4` (hero). 1600×900.
  - `mcp.html?site=1` → `public/media/mcp.{mp4,webm,gif}` (MCP section, and the
    GIF in the README). Rendered at 1280×720 with device scale 1.25.
- **Standalone** (LinkedIn, a post, a talk) — title card, story, end card:
  - `bullpane.html` and `mcp.html` (no `?site`). 1600×900. Not in `public/`.

Each page is one 1600×900 scene drawn as a pure function of time,
`window.renderAt(t)`, so every render is frame-exact. Open a file in a browser
to watch it loop; add `?t=12.5` to freeze a frame.

To render: load the page in headless Chromium, call `renderAt(i / 30)` for each
frame up to `window.DURATION`, screenshot each one, then encode with ffmpeg:

```bash
ffmpeg -framerate 30 -i frames/f%04d.png -c:v libx264 -preset slow -crf 20 \
  -pix_fmt yuv420p -movflags +faststart mcp.mp4            # tour: -crf 26
ffmpeg -framerate 30 -i frames/f%04d.png -c:v libvpx-vp9 -b:v 0 -crf 34 \
  -row-mt 1 -pix_fmt yuv420p mcp.webm
ffmpeg -framerate 30 -i frames/f%04d.png -vf "fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=256:stats_mode=full[p];[b][p]paletteuse=dither=sierra2_4a" mcp.gif
```

The tour uses the real screenshots in `public/shots/`; retake those and re-render
when the UI changes. Fonts come from Google Fonts, so render online.
