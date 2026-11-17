"""Frame effect `binarization`: same PIL operation as the image tool Tools/binarization."""
from PIL import Image, ImageOps


def apply(img: Image.Image, threshold: int) -> Image.Image:
    t = int(threshold)
    gray = ImageOps.grayscale(img).point(lambda x: 0 if x < t else 255)
    return gray.convert("RGB")
