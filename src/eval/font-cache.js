// font-cache.js — Shared font loading and caching for text primitives.
// Separated from evaluator.js to avoid circular dependencies.

import { FontLoader } from 'three/addons/loaders/FontLoader.js';

const FONT_BASE = 'https://unpkg.com/three@0.170.0/examples/fonts';
const FONT_URLS = {
  'helvetiker':        `${FONT_BASE}/helvetiker_regular.typeface.json`,
  'helvetiker bold':   `${FONT_BASE}/helvetiker_bold.typeface.json`,
  'optimer':           `${FONT_BASE}/optimer_regular.typeface.json`,
  'optimer bold':      `${FONT_BASE}/optimer_bold.typeface.json`,
  'gentilis':          `${FONT_BASE}/gentilis_regular.typeface.json`,
  'gentilis bold':     `${FONT_BASE}/gentilis_bold.typeface.json`,
  'droid sans':        `${FONT_BASE}/droid/droid_sans_regular.typeface.json`,
  'droid sans bold':   `${FONT_BASE}/droid/droid_sans_bold.typeface.json`,
  'droid serif':       `${FONT_BASE}/droid/droid_serif_regular.typeface.json`,
  'droid serif bold':  `${FONT_BASE}/droid/droid_serif_bold.typeface.json`,
};

const fontCache = {};       // name → Font object (loaded)
const fontLoading = {};     // name → Promise (in-flight)
let onFontLoaded = null;    // callback when a font finishes loading

export function setOnFontLoaded(cb) { onFontLoaded = cb; }

export function getFont(name) {
  if (fontCache[name]) {
    return fontCache[name];
  }
  if (!fontLoading[name]) {
    const url = FONT_URLS[name] || FONT_URLS['helvetiker'];
    const loader = new FontLoader();
    fontLoading[name] = new Promise((resolve) => {
      loader.load(url, (font) => {
        fontCache[name] = font;
        delete fontLoading[name];
        resolve(font);
        if (onFontLoaded) onFontLoaded();
      }, undefined, (err) => {
        // On error, fall back to helvetiker if not already
        console.warn(`[font-cache] font "${name}" failed to load`, err);
        delete fontLoading[name];
        if (name !== 'helvetiker' && fontCache['helvetiker']) {
          fontCache[name] = fontCache['helvetiker'];
          if (onFontLoaded) onFontLoaded();
        }
      });
    });
  }
  return null; // not yet loaded
}
