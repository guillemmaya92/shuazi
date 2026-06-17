"""
Generate the Open Graph social preview image (1200x630) for Shuazi.

Reuses the existing app branding: composites the existing icons/icon-512.png
onto a canvas painted with the app's theme color (#0e1215) and red accent,
then adds the "ShuaziApp" wordmark and tagline.

Output: public/icons/og-image.png

Run:  python scripts/generate_og_image.py
"""
import os
from PIL import Image, ImageDraw, ImageFont

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, "public", "icons")
ICON_SRC = os.path.join(ICONS, "icon-512.png")
OUT = os.path.join(ICONS, "og-image.png")

W, H = 1200, 630
BG = (14, 18, 21)          # #0e1215 - app theme/background color
RED = (224, 16, 24)        # brand red (matches icon gradient)
WHITE = (245, 245, 245)
MUTED = (150, 158, 165)

FONTS = r"C:\Windows\Fonts"
font_brand = ImageFont.truetype(os.path.join(FONTS, "arialbd.ttf"), 92)
font_sub = ImageFont.truetype(os.path.join(FONTS, "segoeui.ttf"), 38)
font_tag = ImageFont.truetype(os.path.join(FONTS, "segoeui.ttf"), 30)

img = Image.new("RGB", (W, H), BG)
draw = ImageDraw.Draw(img)

# subtle red glow accent on the left, behind the icon
glow = Image.new("RGB", (W, H), BG)
gdraw = ImageDraw.Draw(glow)
gdraw.ellipse([-200, 60, 620, 880], fill=(60, 12, 16))
img = Image.blend(img, glow, 0.5)
draw = ImageDraw.Draw(img)

# composite the existing app icon (already contains the 刷字 logo)
icon = Image.open(ICON_SRC).convert("RGBA")
ICON_SIZE = 380
icon = icon.resize((ICON_SIZE, ICON_SIZE), Image.LANCZOS)
icon_x = 110
icon_y = (H - ICON_SIZE) // 2
img.paste(icon, (icon_x, icon_y), icon)

# text block to the right of the icon
tx = icon_x + ICON_SIZE + 80
draw.text((tx, 230), "ShuaziApp", font=font_brand, fill=WHITE)
draw.text((tx, 335), "Learn Chinese Hanzi", font=font_sub, fill=RED)
draw.text((tx, 400), "Flashcards · Characters · Radicals", font=font_tag, fill=MUTED)

img.save(OUT, "PNG", optimize=True)
print("Wrote", OUT, img.size)
