#!/usr/bin/env python3
"""Generate the synthetic demo images under examples/.

These are deliberately synthetic: a flat-lighting product scene with a ceramic
vase on a gradient background. `after.png` shrinks only the subject, inside the
mask, so every background pixel is byte-identical to `before.png`.
`after-leak.png` adds a +4/+3/+2 exposure drift to every pixel OUTSIDE the mask,
which is exactly the failure this plugin is built to catch.

    python examples/generate_examples.py
"""

import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
WIDTH, HEIGHT = 640, 400
SUPERSAMPLE = 2
MASK_BOX = (205, 80, 435, 390)


def background():
    """Deterministic warm studio background, shared by every render."""
    w, h = WIDTH * SUPERSAMPLE, HEIGHT * SUPERSAMPLE
    rng = np.random.default_rng(20261022)

    y = np.linspace(0.0, 1.0, h)[:, None]
    x = np.linspace(0.0, 1.0, w)[None, :]

    top = np.array([248, 240, 228], dtype=np.float64)
    bottom = np.array([214, 191, 163], dtype=np.float64)
    canvas = top[None, None, :] * (1 - y[:, :, None]) + bottom[None, None, :] * y[:, :, None]

    # Soft key light from the upper left.
    cx, cy = 0.32 * w, 0.26 * h
    dist = np.sqrt(((np.arange(w)[None, :] - cx) / w) ** 2 + ((np.arange(h)[:, None] - cy) / h) ** 2)
    glow = np.clip(1.0 - dist / 0.52, 0.0, 1.0)[:, :, None] ** 1.7
    canvas = canvas + glow * np.array([26.0, 22.0, 16.0])

    # Gentle vignette and a barely visible paper grain.
    vignette = 1.0 - 0.16 * (((x - 0.5) ** 2 + (y - 0.5) ** 2) / 0.5)
    canvas = canvas * vignette[:, :, None]
    canvas = canvas + rng.normal(0.0, 1.1, (h, w, 1))

    return np.clip(canvas, 0, 255).astype(np.uint8)


def draw_vase(canvas, scale):
    """Draw the subject; scale 1.0 is the original, <1 shrinks toward the base."""
    size = (WIDTH * SUPERSAMPLE, HEIGHT * SUPERSAMPLE)
    image = Image.fromarray(canvas, "RGB").convert("RGBA")
    cx = 320 * SUPERSAMPLE
    base = 350 * SUPERSAMPLE
    s = scale * SUPERSAMPLE

    # Contact shadow, kept well inside the mask.
    shadow = Image.new("RGBA", size, (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.ellipse(
        [cx - 86 * s, base - 20 * s, cx + 86 * s, base + 14 * s],
        fill=(58, 43, 33, 95),
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(9 * SUPERSAMPLE))
    image = Image.alpha_composite(image, shadow)
    draw = ImageDraw.Draw(image, "RGBA")

    body_box = [cx - 63 * s, base - 182 * s, cx + 63 * s, base - 42 * s]
    neck_box = [cx - 19 * s, base - 226 * s, cx + 19 * s, base - 160 * s]
    rim_box = [cx - 27 * s, base - 241 * s, cx + 27 * s, base - 219 * s]

    draw.ellipse(body_box, fill=(191, 104, 74, 255))
    draw.rectangle(neck_box, fill=(185, 98, 69, 255))
    draw.ellipse([neck_box[0], neck_box[1] - 7 * s, neck_box[2], neck_box[1] + 9 * s], fill=(193, 106, 76, 255))
    draw.ellipse(rim_box, fill=(206, 120, 88, 255))
    draw.ellipse([rim_box[0] + 4 * s, rim_box[1] + 4 * s, rim_box[2] - 4 * s, rim_box[3] - 2 * s], fill=(120, 58, 42, 255))

    # Left highlight and right shadow give the flat shape some volume.
    draw.ellipse(
        [body_box[0] + 7 * s, body_box[1] + 14 * s, body_box[0] + 48 * s, body_box[3] - 22 * s],
        fill=(236, 164, 126, 90),
    )
    draw.ellipse(
        [body_box[2] - 44 * s, body_box[1] + 26 * s, body_box[2] - 8 * s, body_box[3] - 16 * s],
        fill=(104, 46, 33, 70),
    )

    # A cream band near the foot.
    draw.rectangle(
        [cx - 56 * s, base - 86 * s, cx + 56 * s, base - 64 * s],
        fill=(232, 210, 179, 255),
    )
    draw.line(
        [cx - 56 * s, base - 64 * s, cx + 56 * s, base - 64 * s],
        fill=(166, 127, 94, 150),
        width=max(1, int(1.4 * SUPERSAMPLE)),
    )

    return image.convert("RGB").resize((WIDTH, HEIGHT), Image.LANCZOS)


def make_mask():
    mask = Image.new("L", (WIDTH, HEIGHT), 0)
    draw = ImageDraw.Draw(mask)
    draw.rounded_rectangle(MASK_BOX, radius=26, fill=255)
    return mask


def main():
    base = background()
    before = draw_vase(base, 1.0)
    after = draw_vase(base, 0.82)
    mask = make_mask()

    # Leak: an exposure drift applied only outside the mask.
    after_np = np.asarray(after).astype(np.int16)
    mask_np = np.asarray(mask) > 127
    leak = after_np.copy()
    for channel, delta in enumerate((4, 3, 2)):
        plane = leak[:, :, channel]
        plane[~mask_np] = np.clip(plane[~mask_np] + delta, 0, 255)
    leak = np.clip(leak, 0, 255).astype(np.uint8)

    before.save(os.path.join(HERE, "before.png"))
    after.save(os.path.join(HERE, "after.png"))
    Image.fromarray(leak, "RGB").save(os.path.join(HERE, "after-leak.png"))
    mask.save(os.path.join(HERE, "mask.png"))

    # Verify the invariant the demo claims, using Pillow rather than our plugin.
    outside = ~mask_np
    difference = np.abs(np.asarray(before).astype(np.int16) - np.asarray(after).astype(np.int16))
    if difference[outside].max() != 0:
        ys, xs = np.where((difference.max(axis=2) > 0) & outside)
        print("outside-mask diff pixels:", len(xs), "bbox:", xs.min(), ys.min(), xs.max(), ys.max())
        print("max delta:", int(difference[outside].max()))
    assert difference[outside].max() == 0, "after.png changed a pixel outside the mask"
    leak_difference = np.abs(np.asarray(before).astype(np.int16) - leak.astype(np.int16))
    assert leak_difference[outside].max() == 4, "leak image should differ by at most 4"

    print("wrote examples: before.png, after.png, after-leak.png, mask.png")
    print("outside-mask changed pixels: after=0, after-leak=", int((leak_difference.max(axis=2)[outside] > 0).sum()))


if __name__ == "__main__":
    main()
