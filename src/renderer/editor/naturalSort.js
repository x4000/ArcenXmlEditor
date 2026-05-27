/**
 * Natural-order comparison that mirrors Windows Explorer's filename sort
 * without relying on platform-specific APIs (StrCmpLogicalW etc.).
 *
 * Two key differences from `String.prototype.localeCompare()` defaults:
 *
 *  1. `numeric: true` makes embedded digit runs compare as numbers, so
 *     `file2.xml` sorts before `file10.xml` — not after, as a plain
 *     lexicographic compare would have it.
 *
 *  2. The `Intl.Collator` Unicode Collation Algorithm gives punctuation
 *     and whitespace a lower primary weight than letters. That's what
 *     makes `Contemplation_Ch2.xml` sort BEFORE `ContemplationZ_Beta.xml`
 *     — the underscore character is treated as a separator that comes
 *     before any letter, matching Windows Explorer. With raw ASCII this
 *     is reversed (`_` is 0x5F, after most letters), which is why the
 *     pre-existing `xmlFiles.sort()` and `localeCompare(...)` calls were
 *     producing the wrong order.
 *
 * Locked to the `'en'` locale on purpose: we want stable ordering across
 * every platform / locale the editor runs on, not whatever the OS default
 * happens to be. Western numeric + alphabetic semantics are what users
 * expect for file paths.
 */
const _collator = new Intl.Collator('en', {
  numeric: true,
  sensitivity: 'variant',
});

export function naturalCompare(a, b) {
  return _collator.compare(a, b);
}
