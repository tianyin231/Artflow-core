from __future__ import annotations

import json
import math
import random
import re
import subprocess
import sys
import wave
from dataclasses import dataclass
from hashlib import md5
from pathlib import Path

import numpy as np
from imageio_ffmpeg import get_ffmpeg_exe
from moviepy import AudioFileClip, ColorClip, CompositeVideoClip, ImageClip, concatenate_videoclips, afx, vfx
from PIL import Image, ImageDraw, ImageEnhance, ImageFilter, ImageFont
from proglog import ProgressBarLogger


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
class EffectShot:
    effect: str
    zoom: float
    intensity: float


@dataclass(frozen=True)
class EffectPlan:
    style_hint: str | None
    shots: list[EffectShot]


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
    effect_plan: EffectPlan | None


class TenPercentLogger(ProgressBarLogger):
    def __init__(self) -> None:
        super().__init__()
        self._last_bucket = 0

    def bars_callback(self, bar: str, attr: str, value, old_value=None) -> None:
        if attr != "index":
            return
        total = self.bars.get(bar, {}).get("total")
        if not total:
            return
        percent = min(100, int((value / total) * 100))
        bucket = (percent // 10) * 10
        if bucket >= 10 and bucket > self._last_bucket:
            self._last_bucket = bucket
            print(f"Render progress: {bucket}%", flush=True)


def clamp_text(text: str, limit: int) -> str:
    clean = " ".join(text.split())
    return clean if len(clean) <= limit else f"{clean[: max(limit - 1, 0)]}…"


def load_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for font_path in (
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "C:/Windows/Fonts/simsun.ttc",
        "C:/Windows/Fonts/arialuni.ttf",
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/Hiragino Sans GB.ttc",
        "/Library/Fonts/Arial Unicode.ttf",
    ):
        try:
            return ImageFont.truetype(font_path, size)
        except Exception:
            continue
    return ImageFont.load_default()


def infer_credit_from_path(path: Path) -> tuple[str | None, str | None]:
    stem = path.stem
    match = re.match(r"^(\d+)[_ -]+(.+?)(?:_\d+)?$", stem)
    if not match:
        return None, stem or None
    title = match.group(2).replace("_", " ").strip()
    return match.group(1), title or None


def make_credit_overlay(path: Path, config: RenderConfig) -> Path | None:
    credit = config.image_credits.get(str(path))
    inferred_pixiv_id, inferred_title = infer_credit_from_path(path)
    if not credit:
        credit = ImageCredit(path, inferred_pixiv_id, inferred_title, None, None, None)

    author = credit.author_name or credit.author_account or "Pixiv 来源待确认"
    pixiv_id = credit.pixiv_id or inferred_pixiv_id
    pixiv = f"Pixiv ID: {credit.pixiv_id}" if credit.pixiv_id else "Pixiv source"
    if pixiv_id:
        pixiv = f"Pixiv ID: {pixiv_id}"
    line_one = f"© {clamp_text(author, 28)}" if credit.author_name or credit.author_account else clamp_text(author, 28)
    author_code = credit.author_id or credit.author_account
    title = credit.title or inferred_title
    line_two = clamp_text(f"{pixiv}{f' · UID: {author_code}' if author_code else ''}", 44)
    line_three = clamp_text(title or path.name, 42)

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
    box_w = min(round(width * 0.62), max(draw.textlength(line_one, font=font), draw.textlength(line_two, font=small_font), draw.textlength(line_three, font=small_font)) + padding_x * 2)
    box_h = font_size + small_size * 2 + line_gap * 2 + padding_y * 2
    x = width - box_w - margin
    y = height - box_h - margin
    draw.rounded_rectangle((x, y, x + box_w, y + box_h), radius=10, fill=(0, 0, 0, 118))
    draw.text((x + padding_x, y + padding_y), line_one, fill=(255, 255, 255, 224), font=font)
    draw.text((x + padding_x, y + padding_y + font_size + line_gap), line_two, fill=(255, 255, 255, 190), font=small_font)
    draw.text((x + padding_x, y + padding_y + font_size + small_size + line_gap * 2), line_three, fill=(255, 255, 255, 170), font=small_font)

    cache_dir = config.output_path.parent / "_render_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_key = md5(f"{line_one}|{line_two}|{line_three}|{width}x{height}".encode("utf-8")).hexdigest()[:10]
    cache_path = cache_dir / f"{path.stem}-{width}x{height}-{cache_key}-credit.png"
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
    cache_key = md5(json.dumps({
        "title": disclaimer.title,
        "lines": disclaimer.lines,
        "duration": disclaimer.duration,
        "size": [width, height],
    }, ensure_ascii=False, sort_keys=True).encode("utf-8")).hexdigest()[:10]
    cache_path = cache_dir / f"disclaimer-{width}x{height}-{cache_key}.png"
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
        inferred_pixiv_id, inferred_title = infer_credit_from_path(credit_path)
        image_credits[str(credit_path)] = ImageCredit(
            path=credit_path,
            pixiv_id=str(item["pixivId"]) if item.get("pixivId") else inferred_pixiv_id,
            title=str(item["title"]) if item.get("title") else inferred_title,
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
    effect_plan_data = data.get("effectPlan") or {}
    effect_shots = []
    allowed_effects = {"slow_zoom", "pan_left", "pan_right", "pan_up", "pan_down", "drift", "sway", "pulse"}
    for item in effect_plan_data.get("shots") or []:
        effect = str(item.get("effect") or "")
        if effect not in allowed_effects:
            continue
        effect_shots.append(EffectShot(
            effect=effect,
            zoom=min(max(float(item.get("zoom") or 1.05), 1.0), 1.18),
            intensity=min(max(float(item.get("intensity") or 0.6), 0.0), 1.0),
        ))
    effect_plan = EffectPlan(
        style_hint=str(effect_plan_data.get("styleHint") or "") or None,
        shots=effect_shots,
    ) if effect_shots else None
    return RenderConfig(
        image_paths=[Path(item) for item in data["imagePaths"]],
        output_path=Path(data["outputPath"]),
        size=(int(data["size"]["width"]), int(data["size"]["height"])),
        fps=int(data["fps"]),
        seconds_per_image=max(float(data["secondsPerImage"]), 4.0),
        crossfade=min(max(float(data["crossfade"]), 0.35), 0.9),
        zoom=min(float(data["zoom"]), 1.06),
        shuffle_seed=int(data["shuffleSeed"]),
        max_images=int(data["maxImages"]),
        motion=str(data.get("motion") or "slow_zoom"),
        bgm_path=Path(data["bgmPath"]) if data.get("bgmPath") else None,
        image_credits=image_credits,
        disclaimer=disclaimer,
        effect_plan=effect_plan,
    )


def make_clip(path: Path, config: RenderConfig, index: int) -> CompositeVideoClip:
    width, height = config.size
    with Image.open(path) as image:
        image_width, image_height = image.size

    motion = config.motion
    shot = config.effect_plan.shots[index % len(config.effect_plan.shots)] if config.effect_plan and config.effect_plan.shots else None
    shot_effect = shot.effect if shot else None
    if motion == "auto":
        motion = ["slow_zoom", "pan_zoom", "slide_parallax", "drift_zoom", "cinematic_sway", "pulse_pop"][index % 6]
    if shot_effect:
        motion = {
            "slow_zoom": "slow_zoom",
            "pan_left": "pan_zoom",
            "pan_right": "pan_zoom",
            "pan_up": "drift_zoom",
            "pan_down": "drift_zoom",
            "drift": "drift_zoom",
            "sway": "cinematic_sway",
            "pulse": "pulse_pop",
        }[shot_effect]

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
        motion_zoom = shot.zoom if shot else config.zoom
        if motion in {"beat_zoom", "beat_cut", "pulse_pop"}:
            motion_zoom = max(config.zoom, 1.1 if index % 2 == 0 else 1.05)
            if shot:
                motion_zoom = max(shot.zoom, 1.04 + 0.08 * shot.intensity)
        if motion == "drift_zoom":
            motion_zoom = max(config.zoom, 1.07)
            if shot:
                motion_zoom = max(shot.zoom, 1.035 + 0.05 * shot.intensity)
        if motion == "cinematic_sway":
            motion_zoom = max(config.zoom, 1.045)
            if shot:
                motion_zoom = max(shot.zoom, 1.025 + 0.035 * shot.intensity)
        image_clip = image_clip.resized(lambda t: 1 + ((motion_zoom - 1) * (t / config.seconds_per_image)))
    if motion in {"pan_zoom", "slide_parallax", "drift_zoom", "cinematic_sway"}:
        direction = -1 if index % 2 else 1
        if shot_effect == "pan_left":
            direction = -1
        elif shot_effect == "pan_right":
            direction = 1
        travel = round(width * (0.015 + (0.03 * (shot.intensity if shot else 0.65))) if motion != "cinematic_sway" else width * 0.025)
        background = background.with_position(lambda t: (-direction * travel * 0.45 * (t / config.seconds_per_image), "center"))
        if motion == "pan_zoom" and shot_effect in {"pan_left", "pan_right"}:
            start_x = -direction * round(travel * 0.45)
            image_clip = image_clip.with_position(lambda t: (start_x + direction * travel * 0.9 * (t / config.seconds_per_image), "center"))
        elif motion == "slide_parallax":
            start_x = -travel if direction > 0 else travel
            image_clip = image_clip.with_position(lambda t: (start_x + direction * travel * 2 * (t / config.seconds_per_image), "center"))
        elif motion == "drift_zoom":
            if shot_effect == "pan_up":
                start_y = round(height * 0.024)
            elif shot_effect == "pan_down":
                start_y = -round(height * 0.024)
            else:
                start_y = -round(height * 0.018) if index % 2 else round(height * 0.018)
            image_clip = image_clip.with_position(lambda t: ("center", start_y - start_y * 2 * (t / config.seconds_per_image)))
        elif motion == "cinematic_sway":
            angle = (0.35 + 0.8 * (shot.intensity if shot else 0.65)) * (1 if index % 2 else -1)
            image_clip = image_clip.rotated(lambda t: angle * (t / config.seconds_per_image), resample="bicubic", expand=False)
    if motion == "pulse_pop":
        pulse = 0.012 + 0.025 * (shot.intensity if shot else 0.65)
        image_clip = image_clip.resized(lambda t: 1.0 + pulse * (1 - abs((t / config.seconds_per_image) * 2 - 1)))
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


def make_default_audio_file(config: RenderConfig, duration: float) -> Path:
    sample_rate = 44100
    cache_dir = config.output_path.parent / "_render_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / f"default-bgm-{round(duration * 1000)}ms.wav"
    if cache_path.exists():
        return cache_path

    print("Audio: generating default background track", flush=True)
    total_samples = max(1, int(duration * sample_rate))
    t = np.arange(total_samples, dtype=np.float32) / sample_rate
    tone = (
        0.035 * np.sin(2 * math.pi * 220 * t)
        + 0.024 * np.sin(2 * math.pi * 330 * t)
        + 0.018 * np.sin(2 * math.pi * 440 * t)
    )
    fade_samples = min(int(sample_rate * 1.2), total_samples // 2)
    if fade_samples > 0:
        fade_in = np.linspace(0, 1, fade_samples, dtype=np.float32)
        fade_out = np.linspace(1, 0, fade_samples, dtype=np.float32)
        tone[:fade_samples] *= fade_in
        tone[-fade_samples:] *= fade_out
    pcm = np.clip(tone * 32767, -32768, 32767).astype(np.int16)
    stereo = np.column_stack([pcm, pcm]).ravel()
    with wave.open(str(cache_path), "wb") as audio_file:
        audio_file.setnchannels(2)
        audio_file.setsampwidth(2)
        audio_file.setframerate(sample_rate)
        audio_file.writeframes(stereo.tobytes())
    return cache_path


def prepare_bgm(config: RenderConfig, duration: float) -> tuple[AudioFileClip | None, Path | None]:
    if not config.bgm_path:
        audio_path = make_default_audio_file(config, duration)
        return AudioFileClip(str(audio_path)), audio_path
    if not config.bgm_path.exists():
        raise RuntimeError(f"BGM file does not exist: {config.bgm_path}")

    audio = AudioFileClip(str(config.bgm_path))
    if audio.duration < duration:
        audio = audio.with_effects([afx.AudioLoop(duration=duration)])
        audio_path = config.output_path.parent / "_render_cache" / f"looped-bgm-{round(duration * 1000)}ms.wav"
        print("Audio: preparing looped BGM", flush=True)
        audio.write_audiofile(str(audio_path), fps=44100, nbytes=2, codec="pcm_s16le", logger=None)
    else:
        audio = audio.subclipped(0, duration)
        audio_path = config.output_path.parent / "_render_cache" / f"trimmed-bgm-{round(duration * 1000)}ms.wav"
        print("Audio: preparing trimmed BGM", flush=True)
        audio.write_audiofile(str(audio_path), fps=44100, nbytes=2, codec="pcm_s16le", logger=None)
    audio = audio.with_effects([afx.AudioFadeIn(0.5), afx.AudioFadeOut(0.8)]).with_volume_scaled(0.75)
    return audio, audio_path


def mux_audio(video_path: Path, audio_path: Path, output_path: Path) -> None:
    print("Audio: muxing background track", flush=True)
    temp_output = output_path.with_name(f"{output_path.stem}-muxed{output_path.suffix}")
    if temp_output.exists():
        temp_output.unlink()
    subprocess.run(
        [
            get_ffmpeg_exe(),
            "-y",
            "-i",
            str(video_path),
            "-i",
            str(audio_path),
            "-map",
            "0:v:0",
            "-map",
            "1:a:0",
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "160k",
            "-shortest",
            "-movflags",
            "+faststart",
            str(temp_output),
        ],
        check=True,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    temp_output.replace(output_path)


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
    audio_clip, audio_path = prepare_bgm(config, video.duration)
    silent_output_path = config.output_path.with_name(f"{config.output_path.stem}-silent{config.output_path.suffix}")
    video.write_videofile(
        str(silent_output_path),
        fps=config.fps,
        codec="libx264",
        audio=False,
        audio_codec=None,
        preset="medium",
        ffmpeg_params=["-crf", "18", "-pix_fmt", "yuv420p", "-movflags", "+faststart"],
        threads=4,
        logger=TenPercentLogger(),
    )
    video.close()
    if audio_path:
        mux_audio(silent_output_path, audio_path, config.output_path)
        silent_output_path.unlink(missing_ok=True)
    else:
        silent_output_path.replace(config.output_path)
    if audio_clip:
        audio_clip.close()
    for clip in clips:
        clip.close()

    print(json.dumps({"outputPath": str(config.output_path), "imageCount": len(selected_images), "hasDisclaimer": disclaimer_clip is not None}))


if __name__ == "__main__":
    main()
