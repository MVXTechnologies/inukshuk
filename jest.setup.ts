// Global Jest setup.
//
// @testing-library/react-native v14 ships its own matchers, so we only need to
// register lightweight native-module mocks that some libraries touch at import
// time. Pure-logic tests under src/core need none of this but it is harmless.
//
// Note: console.warn is intentionally NOT silenced here — a blanket mock hides
// real regressions (deprecations, act() warnings, bad-prop warnings). If a
// dependency emits a genuinely unavoidable warning, filter that exact message
// here with a comment explaining why.
