"""Frame effect `rotate`: same PIL operation as the image tool Tools/rotate."""
from PIL import Image


def apply(img: Image.Image, degrees: float) -> Image.Image:
    return img.rotate(float(degrees), expand=True)
