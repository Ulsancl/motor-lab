"""Draw Motor Lab's original rotor/brush icon; optional authoring tool (Pillow)."""
from pathlib import Path
from math import cos, sin, pi
from PIL import Image, ImageDraw

target = Path(__file__).resolve().parents[1] / 'desktop' / 'assets'
target.mkdir(parents=True, exist_ok=True)
scale = 3
image = Image.new('RGBA', (512 * scale, 512 * scale))
draw = ImageDraw.Draw(image)
def xy(values): return tuple(round(v * scale) for v in values)
def circle(box, fill, outline=None, width=1): draw.ellipse(xy(box), fill, outline, width * scale)
def line(points, fill, width): draw.line(xy(points), fill, width * scale, joint='curve')
draw.rounded_rectangle(xy((8, 8, 504, 504)), 98 * scale, '#101e31', '#365477', 7 * scale)
circle((74, 74, 438, 438), '#21364c', '#97b5ce', 11)
# Fixed magnet poles around the copper-wound rotor.
draw.arc(xy((92, 92, 420, 420)), 205, 335, '#ffb969', 35 * scale)
draw.arc(xy((92, 92, 420, 420)), 25, 155, '#64d9e9', 35 * scale)
circle((140, 140, 372, 372), '#748797', '#d2e4ec', 5)
for angle in (0, 2*pi/3, 4*pi/3):
    x, y = 256 + 78*cos(angle), 256 + 78*sin(angle)
    for offset in (-12, 0, 12):
        circle((x-29+offset/3, y-41, x+29+offset/3, y+41), None, '#ed9b4a', 6)
circle((218, 218, 294, 294), '#cedee7', '#f1f9fb', 5)
circle((237, 237, 275, 275), '#172c43')
line((60, 256, 130, 256), '#ffbf6b', 19)
line((382, 256, 452, 256), '#68dbe9', 19)
draw.rounded_rectangle(xy((104, 236, 145, 276)), 5 * scale, '#2b2b36', '#cadce3', 4 * scale)
draw.rounded_rectangle(xy((367, 236, 408, 276)), 5 * scale, '#2b2b36', '#cadce3', 4 * scale)
image = image.resize((512, 512), Image.Resampling.LANCZOS)
image.save(target / 'app.png')
image.save(target / 'app.ico', sizes=[(16,16), (24,24), (32,32), (48,48), (64,64), (128,128), (256,256)])
print('Created Motor Lab PNG/ICO assets.')
