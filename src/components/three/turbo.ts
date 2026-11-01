/** Google's Turbo colormap, polynomial approximation. t in 0..1 → linear-ish RGB 0..1. */
export function turbo(t: number): [number, number, number] {
  const x = Math.min(Math.max(t, 0), 1)
  const r = 0.13572138 + x * (4.6153926 + x * (-42.66032258 + x * (132.13108234 + x * (-152.94239396 + x * 59.28637943))))
  const g = 0.09140261 + x * (2.19418839 + x * (4.84296658 + x * (-14.18503333 + x * (4.27729857 + x * 2.82956604))))
  const b = 0.1066733 + x * (12.64194608 + x * (-60.58204836 + x * (110.36276771 + x * (-89.90310912 + x * 27.34824973))))
  return [Math.min(Math.max(r, 0), 1), Math.min(Math.max(g, 0), 1), Math.min(Math.max(b, 0), 1)]
}

export function turboCss(t: number) {
  const [r, g, b] = turbo(t)
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`
}
