"""Render catalog cover templates and the existing manual cover layouts."""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps


def render_cover(data: dict) -> None:
    paths = data["imagePaths"][:6]
    if not paths:
        raise ValueError("No images available for cover generation")
    width, height = int(data["width"]), int(data["height"])
    layout = data.get("layout", "grid")
    canvas = Image.new("RGB", (width, height), (18, 18, 18))

    def paste(path: str, box: tuple[int, int, int, int]) -> None:
        x, y, w, h = box
        with Image.open(path) as image:
            canvas.paste(ImageOps.fit(image.convert("RGB"), (w, h), method=Image.Resampling.LANCZOS), (x, y))

    if layout in {"single", "poster-vertical", "youtube-720p"} or len(paths) == 1:
        paste(paths[0], (0, 0, width, height))
    elif layout in {"hero_left", "collage"}:
        main_w = round(width * 0.62)
        paste(paths[0], (0, 0, main_w, height))
        side = paths[1:4]
        for i, path in enumerate(side):
            y, end_y = round(i * height / len(side)), round((i + 1) * height / len(side))
            paste(path, (main_w, y, width - main_w, end_y - y))
    elif layout == "hero_top":
        main_h = round(height * 0.62)
        paste(paths[0], (0, 0, width, main_h))
        bottom = paths[1:5]
        for i, path in enumerate(bottom):
            x, end_x = round(i * width / len(bottom)), round((i + 1) * width / len(bottom))
            paste(path, (x, main_h, end_x - x, height - main_h))
    elif layout == "strip":
        for i, path in enumerate(paths):
            x, end_x = round(i * width / len(paths)), round((i + 1) * width / len(paths))
            paste(path, (x, 0, end_x - x, height))
    elif len(paths) == 2:
        for i, path in enumerate(paths):
            box = (i * (width // 2), 0, width - width // 2 if i else width // 2, height) if width >= height else (
                0, i * (height // 2), width, height - height // 2 if i else height // 2)
            paste(path, box)
    else:
        cell_w, cell_h = width // 2, height // 2
        for path, box in zip(paths, [(0, 0, cell_w, cell_h), (cell_w, 0, width - cell_w, cell_h),
                                    (0, cell_h, cell_w, height - cell_h), (cell_w, cell_h, width - cell_w, height - cell_h)]):
            paste(path, box)

    style = data.get("titleStyle")
    if style and data.get("title"):
        font = ImageFont.load_default()
        for candidate in ("C:/Windows/Fonts/msyh.ttc", "/System/Library/Fonts/PingFang.ttc",
                          "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"):
            try:
                font = ImageFont.truetype(candidate, int(style["size"]))
                break
            except OSError:
                pass
        draw = ImageDraw.Draw(canvas)
        text = " ".join(str(data["title"]).split())
        while text and draw.textlength(text, font=font) > width - int(style["x"]) * 2:
            text = text[:-1]
        draw.text((int(style["x"]), int(style["y"])), text, fill=style["color"], font=font,
                  stroke_width=2, stroke_fill="#111111")

    output = Path(data["outputPath"])
    output.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(output, quality=92)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: workflow-render-cover.py <cover-config.json>")
    render_cover(json.loads(Path(sys.argv[1]).read_text(encoding="utf-8")))
