import CoreGraphics
import Darwin
import Foundation

func fail(_ message: String) -> Never {
  fputs("native-os-pointer: \(message)\n", stderr)
  exit(2)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard arguments.count == 7, arguments[0] == "drag" else {
  fail("usage: native-os-pointer.swift drag x1 y1 x2 y2 steps delayMs")
}

func number(_ index: Int) -> Double? { Double(arguments[index]) }
guard let x1 = number(1), let y1 = number(2), let x2 = number(3), let y2 = number(4),
      let stepsValue = Int(arguments[5]), let delayMs = Int(arguments[6]),
      x1 >= 0, y1 >= 0, x2 >= 0, y2 >= 0, stepsValue >= 2, stepsValue <= 48,
      delayMs >= 0, delayMs <= 100 else {
  fail("invalid coordinates or drag timing")
}

func post(_ type: CGEventType, at point: CGPoint) {
  guard let event = CGEvent(mouseEventSource: nil, mouseType: type,
                            mouseCursorPosition: point, mouseButton: .left) else {
    fail("could not create Quartz mouse event")
  }
  event.post(tap: .cghidEventTap)
}

let start = CGPoint(x: x1, y: y1)
let end = CGPoint(x: x2, y: y2)
post(.mouseMoved, at: start)
usleep(80_000)
post(.leftMouseDown, at: start)
for step in 1...stepsValue {
  let progress = Double(step) / Double(stepsValue)
  let point = CGPoint(x: x1 + (x2 - x1) * progress, y: y1 + (y2 - y1) * progress)
  post(.leftMouseDragged, at: point)
  if delayMs > 0 { usleep(useconds_t(delayMs * 1_000)) }
}
post(.leftMouseUp, at: end)
usleep(80_000)

let result: [String: Any] = [
  "method": "Quartz CGEvent via cghidEventTap",
  "postedEvents": stepsValue + 3,
  "steps": stepsValue,
  "start": ["x": x1, "y": y1],
  "end": ["x": x2, "y": y2]
]
let data = try JSONSerialization.data(withJSONObject: result, options: [.sortedKeys])
print(String(data: data, encoding: .utf8)!)
