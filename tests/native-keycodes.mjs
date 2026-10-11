const macNativeKeyCodes = Object.freeze({
  Backquote: 50,
  Backspace: 51,
  Delete: 117,
  Escape: 53,
  MetaLeft: 55,
  ShiftLeft: 56,
  KeyS: 1,
  KeyY: 16,
  KeyZ: 6,
  Digit0: 29,
  Digit1: 18,
  Digit2: 19,
  Digit3: 20,
  Digit4: 21,
  Digit5: 23,
  Digit6: 22,
  Digit7: 26,
  Digit8: 28,
  Digit9: 25,
  Numpad0: 82,
  Numpad1: 83,
  Numpad2: 84,
  Numpad3: 85,
  Numpad4: 86,
  Numpad5: 87,
  Numpad6: 88,
  Numpad7: 89,
  Numpad8: 91,
  Numpad9: 92,
});

export function nativeVirtualKeyCode(platform, code, windowsVirtualKeyCode) {
  if (platform !== "darwin") return windowsVirtualKeyCode;
  const value = macNativeKeyCodes[code];
  if (value === undefined) {
    throw new Error(`Missing macOS native keycode for ${code}.`);
  }
  return value;
}
