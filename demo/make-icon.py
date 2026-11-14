
import math
from pathlib import Path

from PIL import Image, ImageDraw

S = 512
img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角深色底
r = 110
d.rounded_rectangle([8, 8, S-8, S-8], radius=r, fill=(13, 17, 23, 255), outline=(48, 58, 70, 255), width=8)

def node(cx, cy, rad, fill, outline):
    d.ellipse([cx-rad, cy-rad, cx+rad, cy+rad], fill=fill, outline=outline, width=14)

blue = (88, 166, 255, 255)
green = (63, 185, 80, 255)
purple = (163, 113, 247, 255)

# 连线
d.line([(168, 190), (168, 380)], fill=blue, width=26)
d.line([(168, 268), (300, 268)], fill=blue, width=26)
d.arc([252, 268, 372, 330], start=180, end=300, fill=purple, width=24)
d.line([(348, 300), (348, 372)], fill=purple, width=26)

# 节点
node(168, 150, 52, (13, 17, 23, 255), blue)
node(168, 392, 52, (13, 17, 23, 255), blue)
node(348, 150, 52, (13, 17, 23, 255), green)
node(348, 392, 52, (13, 17, 23, 255), purple)

out = Path(__file__).resolve().parent.parent / "renderer"
img.save(out / "icon.png")
img.resize((256, 256), Image.LANCZOS).save(out / "icon.ico",
    sizes=[(256, 256), (128, 128), (64, 64), (48, 48), (32, 32), (16, 16)])
print("ICON_OK")
