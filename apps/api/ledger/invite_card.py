"""Small Pillow renderer with explicit licensed-font fallback for group titles."""
import unicodedata
from io import BytesIO
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, PngImagePlugin, features

ASSETS = Path(__file__).parent / "assets"


def font(size, weight=400, filename="StackSansText.ttf"):
    value = ImageFont.truetype(str(ASSETS / filename), size, layout_engine=ImageFont.Layout.RAQM)
    axes = value.get_variation_axes()
    value.set_variation_by_axes([weight if axis["name"] == b"Weight" else axis["default"] for axis in axes])
    return value


def title_fonts(size):
    if not features.check("raqm"):
        raise RuntimeError("Invite images require Pillow RAQM and the libfribidi runtime")
    return [font(size, 600, name) for name in ["StackSansText.ttf", "NotoSansDevanagari.ttf", "NotoEmoji.ttf"]]


def font_choices(name, fonts):
    # Check the shipped font's actual glyphs, never substitute a generic group name.
    choices = {"…": 0, " ": 0}
    for character in set(name):
        if character in {"\u200c", "\u200d", "\ufe0e", "\ufe0f"}:
            choices[character] = None
            continue
        for index, value in enumerate(fonts):
            missing, glyph = value.getmask("\u0378"), value.getmask(character)
            if (glyph.size, bytes(glyph)) != (missing.size, bytes(missing)):
                choices[character] = index
                break
        else:
            raise ValueError("This group name needs a font not included in the invite renderer")
    return choices


def text_runs(text, fonts, choices):
    runs = []
    for character in text:
        index = choices[character]
        if index is None:
            index = runs[-1][1] if runs else 0
        if runs and runs[-1][1] == index:
            runs[-1] = (runs[-1][0] + character, index)
        else:
            runs.append((character, index))
    return [(text, fonts[index]) for text, index in runs]


def text_width(text, fonts, choices):
    return sum(value.getlength(part) for part, value in text_runs(text, fonts, choices))


def title_lines(name, fonts, choices, width):
    lines, current = [], ""
    for word in name.split():
        candidate = f"{current} {word}".strip()
        if current and text_width(candidate, fonts, choices) > width:
            lines.append(current)
            current = word
        else:
            current = candidate
    if current:
        lines.append(current)
    lines = lines or [name]
    if len(lines) > 2:
        lines = [lines[0], " ".join(lines[1:])]
    for index, line in enumerate(lines):
        if text_width(line, fonts, choices) > width:
            while line and text_width(line + "…", fonts, choices) > width:
                # Remove a base and its combining marks together when truncating.
                end = len(line) - 1
                while end and (unicodedata.category(line[end]).startswith("M") or 0x1F3FB <= ord(line[end]) <= 0x1F3FF):
                    end -= 1
                while end and line[end - 1] == "\u200d":
                    end -= 2
                line = line[:end].rstrip()
            lines[index] = line + "…"
    return lines


def draw_title(draw, lines, fonts, choices, x, baseline, leading, fill="#202020", centered=True):
    for line in lines:
        cursor = x - text_width(line, fonts, choices) / 2 if centered else x
        for part, value in text_runs(line, fonts, choices):
            draw.text((cursor, baseline), part, font=value, fill=fill, anchor="ls")
            cursor += value.getlength(part)
        baseline += leading


def invitation_card(name):
    # Claude's centered design keeps both names inside a 630px square crop.
    full_name, name = name, " ".join(name.split())
    fonts = title_fonts(80)
    choices = font_choices(name, fonts)
    lines = title_lines(name, fonts, choices, 600)
    if text_width(name, fonts, choices) > 1200:
        fonts = title_fonts(64)
        lines = title_lines(name, fonts, choices, 600)
    image = Image.new("RGB", (1200, 630), "#FAF8F5")
    draw = ImageDraw.Draw(image)
    two_lines = len(lines) == 2
    with Image.open(ASSETS / "merosplit-icon.png") as logo:
        logo = logo.convert("RGBA").resize((80, 80), Image.Resampling.LANCZOS)
        image.paste(logo, (560, 92 if two_lines else 132), logo)
    draw.text((600, 224 if two_lines else 264), "MeroSplit", font=font(40, 600), fill="#202020", anchor="ms")
    draw_title(draw, lines, fonts, choices, 600, 336 if two_lines else 376, 92)
    draw.text((600, 514 if two_lines else 474), "Join this group to share expenses", font=font(32), fill="#6B6560", anchor="ms")
    result, info = BytesIO(), PngImagePlugin.PngInfo()
    info.add_text("Title", full_name)
    info.add_text("Software", "MeroSplit")
    image.save(result, format="PNG", pnginfo=info)
    return result.getvalue()
