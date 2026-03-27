#!/usr/bin/env python3
"""
Background swap v4: BiRefNet for sharp product extraction, Leo gradient composite.

Changes from v3:
- Removed rectangular logo/banner suppression (was cutting into products)
- BiRefNet already correctly classifies logos and title text as background
- Tested across 45+ listing images: 0% false detection in logo/title regions
"""

import sys
import numpy as np
from PIL import Image
from rembg import remove, new_session


def create_leo_gradient(width, height):
    """Leo exact 4-corner gradient."""
    tl = np.array([0x55, 0x74, 0xa0], dtype=np.float64)
    tr = np.array([0x79, 0xb5, 0xbd], dtype=np.float64)
    bl = np.array([0xef, 0xc1, 0xcc], dtype=np.float64)
    br = np.array([0x3d, 0x88, 0x78], dtype=np.float64)
    fy = np.linspace(0, 1, height).reshape(height, 1, 1)
    fx = np.linspace(0, 1, width).reshape(1, width, 1)
    return tl * (1 - fx) * (1 - fy) + tr * fx * (1 - fy) + bl * (1 - fx) * fy + br * fx * fy


def swap_background(input_path, output_path):
    """Remove background with BiRefNet, composite onto Leo gradient."""
    original = Image.open(input_path).convert('RGB')
    w, h = original.size
    img_arr = np.array(original, dtype=np.float64)
    print(f"Input: {w}x{h}")

    # === BiRefNet background removal ===
    print("Running BiRefNet background removal...")
    session = new_session("birefnet-general")
    transparent = remove(original, session=session, post_process_mask=True)
    alpha = np.array(transparent)[..., 3].astype(np.float64) / 255.0
    print(f"Raw foreground: {(alpha > 0.5).mean()*100:.1f}%")

    # === Clean edges: hard threshold + 1px erosion to remove fringe ===
    from scipy.ndimage import binary_erosion, uniform_filter
    mask_binary = alpha > 0.4
    eroded = binary_erosion(mask_binary, iterations=1)
    alpha = np.where(eroded, alpha, 0.0)
    # Anti-alias at boundary
    edge_smooth = uniform_filter(alpha, size=2)
    boundary = mask_binary & ~eroded
    alpha = np.where(boundary, edge_smooth * 0.5, alpha)

    alpha = np.clip(alpha, 0.0, 1.0)
    print(f"Final foreground: {(alpha > 0.1).mean()*100:.1f}%")

    # === Composite onto Leo gradient ===
    leo = create_leo_gradient(w, h)
    a3 = alpha[:, :, np.newaxis]
    result = img_arr * a3 + leo * (1.0 - a3)
    result = np.clip(result, 0, 255).astype(np.uint8)

    Image.fromarray(result, 'RGB').save(output_path, 'JPEG', quality=94)
    print(f"Saved: {output_path}")


if __name__ == '__main__':
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input_image> <output_image>")
        sys.exit(1)
    swap_background(sys.argv[1], sys.argv[2])
