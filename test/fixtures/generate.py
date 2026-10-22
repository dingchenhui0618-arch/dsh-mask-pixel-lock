#!/usr/bin/env python3
"""Generate the committed PNG compatibility fixtures.

Run from the repository root:

    python test/fixtures/generate.py

The expected RGBA bytes come from Pillow for the Pillow-written files and from
the raw pixel buffer for the custom-written files, so the JavaScript decoder is
checked against a second, independent implementation rather than only against
its own encoder.
"""

import hashlib
import json
import os
import struct
import sys
import zlib

from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
WIDTH, HEIGHT = 9, 7


def pixel(x, y):
    return (
        (x * 29 + y * 7) % 256,
        (x * 11 + y * 37) % 256,
        (x * 53 + y * 3) % 256,
        255 - ((x * 17 + y * 13) % 200),
    )


def sha_rgba(raw):
    return hashlib.sha256(raw).hexdigest()


def chunk(tag, data):
    return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png(path, width, height, bit_depth, color_type, rows, palette=None, trns=None, interlace=0):
    ihdr = struct.pack(">IIBBBBB", width, height, bit_depth, color_type, 0, 0, interlace)
    blob = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
    if palette is not None:
        blob += chunk(b"PLTE", palette)
    if trns is not None:
        blob += chunk(b"tRNS", trns)
    blob += chunk(b"IDAT", zlib.compress(b"".join(rows), 9))
    blob += chunk(b"IEND", b"")
    with open(path, "wb") as handle:
        handle.write(blob)


def apply_filter(row, previous, bpp, filter_type):
    out = bytearray()
    for i, value in enumerate(row):
        left = row[i - bpp] if i >= bpp else 0
        up = previous[i] if previous is not None else 0
        upper_left = previous[i - bpp] if previous is not None and i >= bpp else 0
        if filter_type == 0:
            predictor = 0
        elif filter_type == 1:
            predictor = left
        elif filter_type == 2:
            predictor = up
        elif filter_type == 3:
            predictor = (left + up) // 2
        elif filter_type == 4:
            p = left + up - upper_left
            pa, pb, pc = abs(p - left), abs(p - up), abs(p - upper_left)
            predictor = left if pa <= pb and pa <= pc else (up if pb <= pc else upper_left)
        else:
            raise ValueError(filter_type)
        out.append((value - predictor) & 0xFF)
    return bytes([filter_type]) + bytes(out)


def main():
    expected = {}

    def remember(name, img, raw=None, bit_depth=8, color_type=6):
        # Reopen the file rather than trusting the in-memory image: Pillow only
        # applies a palette's `transparency` when the file is read back.
        reopened = Image.open(os.path.join(HERE, name))
        expected[name] = {
            "width": img.width,
            "height": img.height,
            "bitDepth": reopened.info.get("bit depth", bit_depth),
            "colorType": color_type,
            "rgbaSha256": sha_rgba(raw if raw is not None else reopened.convert("RGBA").tobytes()),
            "rgbaBytes": img.width * img.height * 4,
        }

    # Pillow-written, one file per standard colour type.
    rgb = Image.new("RGB", (WIDTH, HEIGHT))
    rgb.putdata([pixel(x, y)[:3] for y in range(HEIGHT) for x in range(WIDTH)])
    rgb.save(os.path.join(HERE, "rgb.png"))
    remember("rgb.png", rgb, bit_depth=8, color_type=2)

    rgba = Image.new("RGBA", (WIDTH, HEIGHT))
    rgba.putdata([pixel(x, y) for y in range(HEIGHT) for x in range(WIDTH)])
    rgba.save(os.path.join(HERE, "rgba.png"))
    remember("rgba.png", rgba, bit_depth=8, color_type=6)

    gray = Image.new("L", (WIDTH, HEIGHT))
    gray.putdata([(x * 31 + y * 17) % 256 for y in range(HEIGHT) for x in range(WIDTH)])
    gray.save(os.path.join(HERE, "gray.png"))
    remember("gray.png", gray, bit_depth=8, color_type=0)

    gray_alpha = Image.new("LA", (WIDTH, HEIGHT))
    gray_alpha.putdata([((x * 31 + y * 17) % 256, 255 - ((x * 9 + y * 5) % 200)) for y in range(HEIGHT) for x in range(WIDTH)])
    gray_alpha.save(os.path.join(HERE, "gray-alpha.png"))
    remember("gray-alpha.png", gray_alpha, bit_depth=8, color_type=4)

    palette_colors = []
    for i in range(16):
        palette_colors.extend([(i * 17) % 256, (i * 31) % 256, (i * 47) % 256])
    indices = [(x * 3 + y * 5) % 16 for y in range(HEIGHT) for x in range(WIDTH)]

    palette = Image.new("P", (WIDTH, HEIGHT))
    palette.putpalette(palette_colors)
    palette.putdata(indices)
    palette.save(os.path.join(HERE, "palette.png"))
    remember("palette.png", palette, bit_depth=4, color_type=3)

    palette_trns = Image.new("P", (WIDTH, HEIGHT))
    palette_trns.putpalette(palette_colors)
    palette_trns.putdata(indices)
    alphas = bytes([0, 64, 128, 200, 255] + [255] * 11)
    palette_trns.save(os.path.join(HERE, "palette-trns.png"), transparency=alphas)
    remember("palette-trns.png", palette_trns, bit_depth=4, color_type=3)

    # Custom-written 16-bit gray: values chosen to exercise the high-byte rule.
    values = [[(x * 9000 + y * 700 + 1234) % 65536 for x in range(WIDTH)] for y in range(HEIGHT)]
    rows = []
    expected_rgba = bytearray()
    for y in range(HEIGHT):
        row = bytearray([0])
        for x in range(WIDTH):
            value = values[y][x]
            row += struct.pack(">H", value)
            expected_rgba += bytes([value >> 8, value >> 8, value >> 8, 255])
        rows.append(bytes(row))
    write_png(os.path.join(HERE, "gray-16.png"), WIDTH, HEIGHT, 16, 0, rows)
    expected["gray-16.png"] = {
        "width": WIDTH, "height": HEIGHT, "bitDepth": 16, "colorType": 0,
        "rgbaSha256": sha_rgba(bytes(expected_rgba)), "rgbaBytes": WIDTH * HEIGHT * 4,
    }

    # Custom-written 16-bit RGB.
    rows = []
    expected_rgba = bytearray()
    for y in range(HEIGHT):
        row = bytearray([0])
        for x in range(WIDTH):
            r, g, b, _ = pixel(x, y)
            values = (r * 257 + 3, g * 257 + 5, b * 257 + 7)
            for value in values:
                value &= 0xFFFF
                row += struct.pack(">H", value)
                expected_rgba.append(value >> 8)
            expected_rgba.append(255)
        rows.append(bytes(row))
    write_png(os.path.join(HERE, "rgb-16.png"), WIDTH, HEIGHT, 16, 2, rows)
    expected["rgb-16.png"] = {
        "width": WIDTH, "height": HEIGHT, "bitDepth": 16, "colorType": 2,
        "rgbaSha256": sha_rgba(bytes(expected_rgba)), "rgbaBytes": WIDTH * HEIGHT * 4,
    }

    # One row per scanline filter (None/Sub/Up/Average/Paeth).
    fw, fh = 5, 5
    raw_rows = [[pixel(x, y)[:3] for x in range(fw)] for y in range(fh)]
    rows = []
    previous = None
    for y in range(fh):
        row = bytes(v for px in raw_rows[y] for v in px)
        rows.append(apply_filter(row, previous, 3, y % 5))
        previous = row
    write_png(os.path.join(HERE, "filters.png"), fw, fh, 8, 2, rows)
    expected_rgba = bytearray()
    for y in range(fh):
        for x in range(fw):
            expected_rgba += bytes(raw_rows[y][x]) + b"\xff"
    expected["filters.png"] = {
        "width": fw, "height": fh, "bitDepth": 8, "colorType": 2,
        "rgbaSha256": sha_rgba(bytes(expected_rgba)), "rgbaBytes": fw * fh * 4,
    }

    # Adam7 interlaced RGBA, each pass also using a different filter.
    iw, ih = 9, 7
    source = [[pixel(x, y) for x in range(iw)] for y in range(ih)]
    passes = [
        (0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4),
        (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2),
    ]
    rows = []
    pass_index = 0
    for x0, y0, dx, dy in passes:
        pass_w = (iw - x0 + dx - 1) // dx
        pass_h = (ih - y0 + dy - 1) // dy
        if pass_w <= 0 or pass_h <= 0:
            continue
        previous = None
        for py in range(pass_h):
            y = y0 + py * dy
            row = bytearray()
            for px in range(pass_w):
                x = x0 + px * dx
                row += bytes(source[y][x])
            rows.append(apply_filter(bytes(row), previous, 4, (pass_index + py) % 5))
            previous = bytes(row)
        pass_index += 1
    write_png(os.path.join(HERE, "interlaced.png"), iw, ih, 8, 6, rows, interlace=1)
    expected_rgba = bytearray()
    for y in range(ih):
        for x in range(iw):
            expected_rgba += bytes(source[y][x])
    expected["interlaced.png"] = {
        "width": iw, "height": ih, "bitDepth": 8, "colorType": 6,
        "rgbaSha256": sha_rgba(bytes(expected_rgba)), "rgbaBytes": iw * ih * 4,
    }

    # Negative fixtures: a corrupted IDAT CRC and a truncated file.
    with open(os.path.join(HERE, "rgb.png"), "rb") as handle:
        blob = bytearray(handle.read())
    idat = blob.find(b"IDAT")
    blob[idat + 10] ^= 0xFF
    with open(os.path.join(HERE, "bad-crc.png"), "wb") as handle:
        handle.write(blob)
    with open(os.path.join(HERE, "truncated.png"), "wb") as handle:
        handle.write(blob[:60])

    with open(os.path.join(HERE, "fixtures.json"), "w", encoding="utf-8", newline="\n") as handle:
        json.dump(expected, handle, indent=2, sort_keys=True)
        handle.write("\n")

    print("wrote", len(expected), "fixtures to", HERE)
    for name in sorted(expected):
        print(" ", name, expected[name]["rgbaSha256"][:16])


if __name__ == "__main__":
    sys.exit(main())
