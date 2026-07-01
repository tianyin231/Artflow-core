from __future__ import annotations

import json
import random
import sys
from dataclasses import dataclass
from pathlib import Path

from moviepy import AudioFileClip, ColorClip, CompositeVideoClip, ImageClip, concatenate_videoclips, afx, vfx
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont


@dataclass(frozen=True)
class ImageCredit:
    path: Path
    pixiv_id: str | None
    title: str | None
    author_name: str | None
    author_id: str | None
    author_account: str | None


@dataclass(frozen=True)
class DisclaimerConfig:
    enabled: bool
    duration: float
    title: str
    lines: list[str]


@dataclass(frozen=True)
class RenderConfig:
    image_paths: list[Path]
    output_path: Path
    size: tuple[int, int]
    fps: int
    seconds_per_image: float
    crossfade: float
    zoom: float
    shuffle_seed: int
    max_images: int
    motion: str
    bgm_path: Path | None
    image_credits: dict[str, ImageCredit]
    disclaimer: DisclaimerConfig | None


def clamp_text(text: str, limit: int) -> str:
    clean = " ".join(text.split())
    return clean if len(clean) <= limit else f"{clean[: max(limit - 1, 0)]}…"


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for font_path in (
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ):
        try:
            return ImageFont.truetype(font_path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def make_credit_overlay(path: Path, config: RenderConfig) -> Path | None:
    credit = config.image_credits.get(str(path))
    if not credit:
        return None

    author = credit.author_name or credit.author_account or "Unknown artist"
    pixiv = f"Pixiv ID: {credit.pixiv_id}" if credit.pixiv_id else "Pixiv source"
    line_one = f"© {clamp_text(author, 28)}"
    author_code = credit.author_id or credit.author_account
    line_two = clamp_text(f"{pixiv}{f' · UID: {author_code}' if author_code else ''}", 44)

    width, height = config.size
    overlay = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font_size = max(18, round(width / 54))
    small_size = max(15, round(font_size * 0.78))
    font = load_font(font_size)
    small_font = load_font(small_size)
    padding_x = max(18, round(width * 0.018))
    padding_y = max(12, round(height * 0.012))
    margin = max(24, round(min(width, height) * 0.028))
    line_gap = max(4, round(font_size * 0.22))
    box_w = min(round(width * 0.54), max(draw.textlength(line_one, font=font), draw.textlength(line_two, font=small_font)) + padding_x * 2)
    box_h = font_size + small_size + line_gap + padding_y * 2
    x = width - box_w - margin
    y = height - box_h - margin
    draw.rounded_rectangle((x, y, x + box_w, y + box_h), radius=10, fill=(0, 0, 0, 118))
    draw.text((x + padding_x, y + padding_y), line_one, fill=(255, 255, 255, 224), font=font)
    draw.text((x + padding_x, y + padding_y + font_size + line_gap), line_two, fill=(255, 255, 255, 190), font=small_font)

    cache_dir = config.output_path.parent / "_render_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{path.stem}-{width}x{height}-credit.png"
    overlay.save(cache_path)
    return cache_path


def make_blurred_background(path: Path, config: RenderConfig) -> Path:
    width, height = config.size
    cache_dir = config.output_path.parent / "_render_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"{path.stem}-{width}x{height}-blur.jpg"
    if cache_path.exists():
        return cache_path

    with Image.open(path) as image:
        image = image.convert("RGB")
        scale = max(width / image.width, height / image.height) * 1.12
        resized = image.resize((round(image.width * scale), round(image.height * scale)), Image.Resampling.LANCZOS)
        left = max((resized.width - width) // 2, 0)
        top = max((resized.height - height) // 2, 0)
        background = resized.crop((left, top, left + width, top + height))
        background = background.filter(ImageFilter.GaussianBlur(radius=26))
        background = ImageEnhance.Brightness(background).enhance(0.88)
        background = ImageEnhance.Color(background).enhance(1.08)
        background.save(cache_path, quality=90)
    return cache_path


def wrap_text(draw: ImageDraw.ImageDraw, text: str, font: ImageFont.FreeTypeFont | ImageFont.ImageFont, max_width: int) -> list[str]:
    lines: list[str] = []
    for raw_line in text.splitlines():
        current = ""
        for char in raw_line:
            candidate = current + char
            if current and draw.textlength(candidate, font=font) > max_width:
                lines.append(current)
                current = char
            else:
                current = candidate
        if current:
            lines.append(current)
    return lines or [""]


def make_disclaimer_image(config: RenderConfig) -> Path | None:
    disclaimer = config.disclaimer
    if not disclaimer or not disclaimer.enabled or disclaimer.duration <= 0:
        return None

    width, height = config.size
    cache_dir = config.output_path.parent / "_render_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"disclaimer-{width}x{height}.png"
    if cache_path.exists():
        return cache_path

    canvas = Image.new("RGB", (width, height), (246, 247, 249))
    draw = ImageDraw.Draw(canvas)
    title_font = load_font(max(38, round(width / 23)))
    body_font = load_font(max(22, round(width / 44)))
    margin_x = max(72, round(width * 0.09))
    max_text_width = width - margin_x * 2
    y = round(height * 0.22)
    accent = (36, 44, 58)
    muted = (82, 92, 110)
    draw.text((margin_x, y), disclaimer.title, fill=accent, font=title_font)
    y += round(width / 15)
    draw.line((margin_x, y, margin_x + round(width * 0.18), y), fill=(74, 113, 220), width=max(3, round(width / 320)))
    y += round(width / 28)
    for line in disclaimer.lines:
        for wrapped in wrap_text(draw, line, body_font, max_text_width):
            draw.text((margin_x, y), wrapped, fill=muted, font=body_font)
            y += round(width / 29)
        y += round(width / 90)
    canvas.save(cache_path)
    return cache_path


def make_disclaimer_clip(config: RenderConfig) -> CompositeVideoClip | None:
    disclaimer = config.disclaimer
    image_path = make_disclaimer_image(config)
    if not disclaimer or not image_path:
        return None
    clip = ImageClip(str(image_path)).with_duration(disclaimer.duration)
    if config.crossfade > 0:
        clip = clip.with_effects([vfx.FadeIn(min(config.crossfade, 0.35)), vfx.FadeOut(min(config.crossfade, 0.35))])
    return CompositeVideoClip([clip], size=config.size).with_duration(disclaimer.duration)


def load_config(path: Path) -> RenderConfig:
    data = json.loads(path.read_text(encoding="utf-8"))
    image_credits = {}
    for item in data.get("imageCredits") or []:
        credit_path = Path(item.get("path") or "")
        if not str(credit_path):
            continue
        image_credits[str(credit_path)] = ImageCredit(
            path=credit_path,
            pixiv_id=str(item["pixivId"]) if item.get("pixivId") else None,
            title=str(item["title"]) if item.get("title") else None,
            author_name=str(item["authorName"]) if item.get("authorName") else None,
            author_id=str(item["authorId"]) if item.get("authorId") else None,
            author_account=str(item["authorAccount"]) if item.get("authorAccount") else None,
        )
    disclaimer_data = data.get("disclaimer") or {}
    disclaimer = DisclaimerConfig(
        enabled=bool(disclaimer_data.get("enabled", False)),
        duration=float(disclaimer_data.get("duration", 3)),
        title=str(disclaimer_data.get("title") or "免责声明"),
        lines=[str(line) for line in disclaimer_data.get("lines") or []],
    )
    return RenderConfig(
        image_paths=[Path(item) for item in data["imagePaths"]],
        output_path=Path(data["outputPath"]),
        size=(int(data["size"]["width"]), int(data["size"]["height"])),
        fps=int(data["fps"]),
        seconds_per_image=float(data["secondsPerImage"]),
        crossfade=float(data["crossfade"]),
        zoom=float(data["zoom"]),
        shuffle_seed=int(data["shuffleSeed"]),
        max_images=int(data["maxImages"]),
        motion=str(data.get("motion") or "slow_zoom"),
        bgm_path=Path(data["bgmPath"]) if data.get("bgmPath") else None,
        image_credits=image_credits,
        disclaimer=disclaimer,
    )


def make_clip(path: Path, config: RenderConfig, index: int) -> CompositeVideoClip:
    width, height = config.size
    with Image.open(path) as image:
        image_width, image_height = image.size

    motion = config.motion
    if motion == "auto":
        motion = ["slow_zoom", "pan_zoom", "slide_parallax", "drift_zoom", "cinematic_sway", "pulse_pop"][index % 6]

    contain_scale = min(width / image_width, height / image_height)
    foreground_size = (round(image_width * contain_scale), round(image_height * contain_scale))
    background_scale = 1.08

    background = (
        ImageClip(str(make_blurred_background(path, config)))
        .with_duration(config.seconds_per_image)
        .resized(lambda t: background_scale + 0.035 * (t / config.seconds_per_image))
        .with_position("center")
    )
    wash = ColorClip(config.size, color=(255, 255, 255)).with_duration(config.seconds_per_image).with_opacity(0.08)
    image_clip = ImageClip(str(path)).with_duration(config.seconds_per_image).resized(foreground_size).with_position("center")

    if motion != "none":
        motion_zoom = config.zoom
        if motion in {"beat_zoom", "beat_cut", "pulse_pop"}:
            motion_zoom = max(config.zoom, 1.1 if index % 2 == 0 else 1.05)
        if motion == "drift_zoom":
            motion_zoom = max(config.zoom, 1.07)
        if motion == "cinematic_sway":
            motion_zoom = max(config.zoom, 1.045)
        image_clip = image_clip.resized(lambda t: 1 + ((motion_zoom - 1) * (t / config.seconds_per_image)))
    if motion in {"pan_zoom", "slide_parallax", "drift_zoom", "cinematic_sway"}:
        direction = -1 if index % 2 else 1
        travel = round(width * (0.025 if motion == "cinematic_sway" else 0.035))
        background = background.with_position(lambda t: (-direction * travel * 0.45 * (t / config.seconds_per_image), "center"))
        if motion == "slide_parallax":
            start_x = -travel if direction > 0 else travel
            image_clip = image_clip.with_position(lambda t: (start_x + direction * travel * 2 * (t / config.seconds_per_image), "center"))
        elif motion == "drift_zoom":
            start_y = -round(height * 0.018) if index % 2 else round(height * 0.018)
            image_clip = image_clip.with_position(lambda t: ("center", start_y - start_y * 2 * (t / config.seconds_per_image)))
        elif motion == "cinematic_sway":
            angle = 0.8 if index % 2 else -0.8
            image_clip = image_clip.rotated(lambda t: angle * (t / config.seconds_per_image), resample="bicubic", expand=False)
    if motion == "pulse_pop":
        image_clip = image_clip.resized(lambda t: 1.0 + 0.018 * (1 - abs((t / config.seconds_per_image) * 2 - 1)))
    layers = [background, wash, image_clip]
    credit_overlay_path = make_credit_overlay(path, config)
    if credit_overlay_path:
        layers.append(ImageClip(str(credit_overlay_path)).with_duration(config.seconds_per_image))
    if config.crossfade > 0:
        image_clip = image_clip.with_effects([vfx.FadeIn(config.crossfade), vfx.FadeOut(config.crossfade)])
        background = background.with_effects([vfx.FadeIn(config.crossfade), vfx.FadeOut(config.crossfade)])
        layers[0] = background
        layers[2] = image_clip
    return CompositeVideoClip(layers, size=config.size).with_duration(config.seconds_per_image)


def attach_bgm(video: CompositeVideoClip, config: RenderConfig) -> tuple[CompositeVideoClip, AudioFileClip | None]:
    if not config.bgm_path:
        return video, None
    if not config.bgm_path.exists():
        raise RuntimeError(f"BGM file does not exist: {config.bgm_path}")

    audio = AudioFileClip(str(config.bgm_path))
    if audio.duration < video.duration:
        audio = audio.with_effects([afx.AudioLoop(duration=video.duration)])
    else:
        audio = audio.subclipped(0, video.duration)
    audio = audio.with_effects([afx.AudioFadeIn(0.5), afx.AudioFadeOut(0.8)]).with_volume_scaled(0.75)
    return video.with_audio(audio), audio


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("Usage: workflow-render-video.py <render-config.json>")

    config = load_config(Path(sys.argv[1]))
    config.output_path.parent.mkdir(parents=True, exist_ok=True)

    image_paths = [path for path in config.image_paths if path.exists()]
    if not image_paths:
        raise RuntimeError("No existing images were provided")

    random.Random(config.shuffle_seed).shuffle(image_paths)
    selected_images = image_paths[: config.max_images]
    clips = [make_clip(path, config, index) for index, path in enumerate(selected_images)]
    disclaimer_clip = make_disclaimer_clip(config)
    if disclaimer_clip:
        clips.insert(0, disclaimer_clip)

    video = concatenate_videoclips(clips, method="compose", padding=-config.crossfade)
    audio_clip = None
    video, audio_clip = attach_bgm(video, config)
    video.write_videofile(
        str(config.output_path),
        fps=config.fps,
        codec="libx264",
        audio=audio_clip is not None,
        audio_codec="aac" if audio_clip is not None else None,
        preset="medium",
        ffmpeg_params=["-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
        threads=4,
        logger="bar",
    )
    video.close()
    if audio_clip:
        audio_clip.close()
    for clip in clips:
        clip.close()

    print(json.dumps({"outputPath": str(config.output_path), "imageCount": len(selected_images), "hasDisclaimer": disclaimer_clip is not None}))


if __name__ == "__main__":
    main()
