"""Frame effect `contrast`: same PIL operation as the image tool Tools/contrast."""
from PIL import Image, ImageEnhance


def apply(img: Image.Image, contrastFactor: float) -> Image.Image:
    return ImageEnhance.Contrast(img).enhance(float(contrastFactor))
