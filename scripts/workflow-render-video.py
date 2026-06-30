from __future__ import annotations

import json
import random
import sys
from dataclasses import dataclass
from pathlib import Path

from moviepy import AudioFileClip, ColorClip, CompositeVideoClip, ImageClip, concatenate_videoclips, afx, vfx
from PIL import Image


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


def load_config(path: Path) -> RenderConfig:
    data = json.loads(path.read_text(encoding="utf-8"))
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
    )


def make_clip(path: Path, config: RenderConfig, index: int) -> CompositeVideoClip:
    width, height = config.size
    with Image.open(path) as image:
        image_width, image_height = image.size

    scale = max(width / image_width, height / image_height)
    if config.motion == "none":
        scale *= config.zoom
    display_size = (round(image_width * scale), round(image_height * scale))

    image_clip = ImageClip(str(path)).with_duration(config.seconds_per_image).resized(display_size).with_position("center")
    if config.motion != "none":
        motion_zoom = config.zoom
        if config.motion == "beat_zoom":
            motion_zoom = max(config.zoom, 1.08 if index % 2 == 0 else 1.04)
        image_clip = image_clip.resized(lambda t: 1 + ((motion_zoom - 1) * (t / config.seconds_per_image)))
    if config.crossfade > 0:
        image_clip = image_clip.with_effects([vfx.FadeIn(config.crossfade), vfx.FadeOut(config.crossfade)])
    background = ColorClip(config.size, color=(14, 14, 18)).with_duration(config.seconds_per_image)
    return CompositeVideoClip([background, image_clip], size=config.size).with_duration(config.seconds_per_image)


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
        threads=4,
        logger="bar",
    )
    video.close()
    if audio_clip:
        audio_clip.close()
    for clip in clips:
        clip.close()

    print(json.dumps({"outputPath": str(config.output_path), "imageCount": len(selected_images)}))


if __name__ == "__main__":
    main()
