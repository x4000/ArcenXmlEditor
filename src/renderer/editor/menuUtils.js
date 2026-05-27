/**
 * Menu positioning helpers.
 *
 * Context menus and popovers are anchored at the click point but may overflow
 * the window (especially tall menus near the bottom, or wide ones near the right).
 * This helper is intended as a React `ref` callback: after the element mounts
 * and React applies the initial `top`/`left`, we measure and shift if needed.
 *
 * Behavior:
 *   - If the menu would extend past the right edge, shift it leftward so its
 *     right edge aligns with the viewport (minus a small margin).
 *   - If the menu would extend past the bottom edge, shift it upward so its
 *     bottom edge aligns with the viewport. For a click near the bottom this
 *     effectively flips the menu above the cursor.
 *   - Never shift past the top-left corner — clamp at `margin` pixels.
 *
 * Usage:
 *   <div ref={clampToViewport} style={{ position: 'fixed', top: y, left: x, ... }}>
 *     ...menu items...
 *   </div>
 */
export function clampToViewport(el) {
  if (!el) return;
  const margin = 4;
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  if (rect.right > vw - margin) {
    const newLeft = Math.max(margin, vw - rect.width - margin);
    el.style.left = newLeft + 'px';
  }
  if (rect.bottom > vh - margin) {
    const newTop = Math.max(margin, vh - rect.height - margin);
    el.style.top = newTop + 'px';
  }
}
