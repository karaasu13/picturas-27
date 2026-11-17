"""Frame effect `saturation`: same PIL operation as the image tool Tools/saturation."""
from PIL import Image, ImageEnhance


def apply(img: Image.Image, saturationFactor: float) -> Image.Image:
    return ImageEnhance.Color(img).enhance(float(saturationFactor))
