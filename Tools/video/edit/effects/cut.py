"""Frame effect `cut`: same PIL operation as the image tool Tools/cut."""
from PIL import Image


def apply(img: Image.Image, left: int, top: int, right: int, bottom: int) -> Image.Image:
    return img.crop((int(left), int(top), int(right), int(bottom)))
