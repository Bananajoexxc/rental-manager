#!/usr/bin/env python3
"""
Background swap v2: Use rembg for clean product extraction, composite onto Leo gradient.

Uses ML background removal to cleanly extract products, then composites
onto Leo 4-corner gradient. Two-pass approach for multi-item product photos:
1. rembg extracts main subjects
2. Chrominance-based recovery rescues small items rembg missed
3. Logo region force-cleared to prevent DB Cinema logo surviving recovery

Usage: python3 bg_swap.py <input_image> <output_image>
"""

import sys
import numpy as np
from PIL import Image, ImageFilter
from rembg import remove, new_session


def rgb_to_lab(rgb):
    """Convert RGB (0-255) array to LAB color space."""
    rgb_norm = rgb / 255.0
    mask = rgb_norm > 0.04045
    rgb_lin = np.where(mask, ((rgb_norm + 0.055) / 1.055) ** 2.4, rgb_norm / 12.92)
    r, g, b = rgb_lin[..., 0], rgb_lin[..., 1], rgb_lin[..., 2]
    x = r * 0.4124564 + g * 0.3575761 + b * 0.1804375
    y = r * 0.2126729 + g * 0.7151522 + b * 0.0721750
    z = r * 0.0193339 + g * 0.1191920 + b * 0.9503041
    x /= 0.95047
    z /= 1.08883
    def f(t):
        m = t > 0.008856
        return np.where(m, t ** (1/3), 7.787 * t + 16/116)
    fx, fy, fz = f(x), f(y), f(z)
    L = 116 * fy - 16
    a = 500 * (fx - fy)
    b_ch = 200 * (fy - fz)
    return np.stack([L, a, b_ch], axis=-1)


def sample_background_gradient(img_arr):
    """Sample background from border corners."""
    h, w = img_arr.shape[:2]
    m = max(4, int(min(h, w) * 0.025))
    tl = np.median(img_arr[:m, :m, :].reshape(-1, 3), axis=0)
    tr = np.median(img_arr[:m, -m:, :].reshape(-1, 3), axis=0)
    bl = np.median(img_arr[-m:, :m, :].reshape(-1, 3), axis=0)
    br = np.median(img_arr[-m:, -m:, :].reshape(-1, 3), axis=0)
    fy = np.linspace(0, 1, h).reshape(h, 1, 1)
    fx = np.linspace(0, 1, w).reshape(1, w, 1)
    return (tl * (1-fx)*(1-fy) + tr*fx*(1-fy) + bl*(1-fx)*fy + br*fx*fy)


def create_leo_gradient(width, height):
    """Leo exact 4-corner gradient."""
    tl = np.array([0x55, 0x74, 0xa0], dtype=np.float64)
    tr = np.array([0x79, 0xb5, 0xbd], dtype=np.float64)
    bl = np.array([0xef, 0xc1, 0xcc], dtype=np.float64)
    br = np.array([0x3d, 0x88, 0x78], dtype=np.float64)

    fy = np.linspace(0, 1, height).reshape(height, 1, 1)
    fx = np.linspace(0, 1, width).reshape(1, width, 1)

    return (
        tl * (1 - fx) * (1 - fy) +
        tr * fx * (1 - fy) +
        bl * (1 - fx) * fy +
        br * fx * fy
    )


def swap_background(input_path, output_path):
    """Remove background with rembg + chrominance recovery, composite onto Leo gradient."""
    original = Image.open(input_path).convert('RGB')
    w, h = original.size
    img_arr = np.array(original, dtype=np.float64)
    print(f"Input: {w}x{h}")

    # === Pass 1: rembg ML background removal ===
    print("Running rembg background removal...")
    session = new_session("u2net")
    transparent = remove(original, session=session, post_process_mask=True)
    rembg_alpha = np.array(transparent)[..., 3].astype(np.float64) / 255.0
    print(f"rembg foreground: {(rembg_alpha > 0.5).mean()*100:.1f}%")

    # === Pass 2: Chrominance recovery for small items rembg missed ===
    # Sample the DB Cinema background gradient
    db_gradient = sample_background_gradient(img_arr)
    img_lab = rgb_to_lab(img_arr)
    db_lab = rgb_to_lab(db_gradient)

    # Chrominance distance (items have different hue from background)
    chroma_diff = np.sqrt(
        (img_lab[..., 1] - db_lab[..., 1]) ** 2 +
        (img_lab[..., 2] - db_lab[..., 2]) ** 2
    )
    # High threshold = only strong foreground objects (avoids recovering shadows)
    chroma_alpha = np.clip(chroma_diff / 25.0, 0.0, 1.0)

    # === Combine: union of both masks ===
    # Take the max of rembg and chrominance (keeps anything either method detects)
    combined_alpha = np.maximum(rembg_alpha, chroma_alpha)

    # === Suppress known artifact regions ===
    # 1. Logo region: bottom 25%, right 30% (DB Cinema logo + text + icon)
    logo_top = int(h * 0.75)
    logo_left = int(w * 0.70)
    feather_y = max(1, int(h * 0.03))
    feather_x = max(1, int(w * 0.03))
    ys = np.arange(h).reshape(h, 1)
    xs = np.arange(w).reshape(1, w)
    dy = np.clip((ys - logo_top) / feather_y, 0.0, 1.0)
    dx = np.clip((xs - logo_left) / feather_x, 0.0, 1.0)
    logo_suppression = dy * dx
    combined_alpha = combined_alpha * (1.0 - logo_suppression)

    # 2. Title banner: top 15% of image (black bar with white text + border shadow)
    banner_bottom = int(h * 0.15)
    banner_feather = max(1, int(h * 0.03))
    banner_mask = np.clip((banner_bottom - ys) / banner_feather, 0.0, 1.0)
    combined_alpha = combined_alpha * (1.0 - banner_mask)

    # Smooth edges
    from scipy.ndimage import gaussian_filter
    combined_alpha = gaussian_filter(combined_alpha, sigma=1.0)
    combined_alpha = np.clip(combined_alpha, 0.0, 1.0)

    print(f"Combined foreground: {(combined_alpha > 0.5).mean()*100:.1f}%")

    # === Composite onto Leo gradient ===
    leo_gradient = create_leo_gradient(w, h)
    alpha_3d = combined_alpha[:, :, np.newaxis]
    result = img_arr * alpha_3d + leo_gradient * (1.0 - alpha_3d)
    result = np.clip(result, 0, 255).astype(np.uint8)

    Image.fromarray(result, 'RGB').save(output_path, 'JPEG', quality=94)
    print(f"Saved: {output_path}")


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input_image> <output_image>")
        sys.exit(1)
    swap_background(sys.argv[1], sys.argv[2])
