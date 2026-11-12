/** "16 linear ft", "20 boxes", "12": a quantity in its purchase unit, where "each" goes unsaid. */
export function units(quantity: number, unit = "each"): string {
  if (unit === "each") return String(quantity);
  if (quantity === 1) return `1 ${unit}`;
  const words = unit.split(" ");
  const last = words.pop()!;
  const plural = /^(?:ft|in|yd|m|cm|mm|lb|lbs|kg|oz|sf|sq)$/i.test(last) || /\d|s$/i.test(last) ? last
    : /(?:x|z|ch|sh)$/i.test(last) ? `${last}es` : /[^aeiou]y$/i.test(last) ? `${last.slice(0, -1)}ies` : /(?:l|r)f$/i.test(last) ? `${last.slice(0, -1)}ves` : `${last}s`;
  return `${quantity} ${[...words, plural].join(" ")}`;
}
