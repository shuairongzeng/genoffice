// Local stub replacing optional sharp dependency so Magic Context falls back cleanly
// without shipping LGPL libvips native binaries.
export default function sharpDisabled() {
  throw new Error('Could not load the "sharp" module (disabled by GenOffice license policy)')
}
