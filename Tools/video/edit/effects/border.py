"""Frame effect `border`: same PIL operation as the image tool Tools/border."""
from PIL import Image, ImageOps


def apply(img: Image.Image, borderWidth: int, r: int, g: int, b: int) -> Image.Image:
    return ImageOps.expand(img, border=int(borderWidth), fill=(int(r), int(g), int(b)))
