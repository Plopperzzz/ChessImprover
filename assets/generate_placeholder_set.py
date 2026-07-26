"""One-off generator for the 'default' placeholder asset set (board + 12 pieces).
Run manually if the default set ever needs regenerating: python3 generate_placeholder_set.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

OUT = os.path.join(os.path.dirname(__file__), "sets", "default")
os.makedirs(OUT, exist_ok=True)

SQUARE = 90
BOARD = SQUARE * 8
LIGHT = (235, 224, 200)
DARK = (150, 113, 87)

FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
LETTERS = {"k": "K", "q": "Q", "r": "R", "b": "B", "n": "N", "p": "P"}


def make_board():
    img = Image.new("RGB", (BOARD, BOARD))
    d = ImageDraw.Draw(img)
    for r in range(8):
        for c in range(8):
            color = LIGHT if (r + c) % 2 == 0 else DARK
            d.rectangle([c * SQUARE, r * SQUARE, (c + 1) * SQUARE, (r + 1) * SQUARE], fill=color)
    img.save(os.path.join(OUT, "board.png"))


def make_piece(color, letter):
    size = SQUARE
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = 6
    fill = (250, 250, 250, 255) if color == "w" else (35, 35, 40, 255)
    outline = (30, 30, 30, 255) if color == "w" else (235, 235, 235, 255)
    d.ellipse([pad, pad, size - pad, size - pad], fill=fill, outline=outline, width=4)
    font = ImageFont.truetype(FONT_PATH, int(size * 0.5))
    text = letter
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    text_color = (20, 20, 20, 255) if color == "w" else (245, 245, 245, 255)
    d.text(((size - tw) / 2 - bbox[0], (size - th) / 2 - bbox[1]), text, font=font, fill=text_color)
    img.save(os.path.join(OUT, f"{color}{letter.lower()}.png"))


make_board()
for color in ("w", "b"):
    for key, letter in LETTERS.items():
        make_piece(color, letter)

print("Wrote placeholder asset set to", OUT)
