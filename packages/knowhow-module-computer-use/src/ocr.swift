#!/usr/bin/env swift
// Vision OCR helper for @tyvm/knowhow-module-computer-use
// Usage: swift ocr.swift <image_path>
// Reads a PNG/JPEG image and outputs JSON array of recognized text regions.
// Each region: { text, confidence, x, y, w, h }
// Coordinates are NORMALIZED (0-1), origin bottom-left (Vision convention).
// The TS caller converts to absolute pixel coords using image dimensions.
import Vision
import Foundation
import AppKit

let path = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : ""
guard !path.isEmpty, let img = NSImage(contentsOfFile: path),
      let cgImg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
  print("{\"error\":\"no image\",\"path\":\"\(path)\"}")
  exit(1)
}

let request = VNRecognizeTextRequest()
request.recognitionLevel = .accurate
request.usesLanguageCorrection = false  // faster, good for UI text

let handler = VNImageRequestHandler(cgImage: cgImg)
do {
  try handler.perform([request])
} catch {
  print("{\"error\":\"\(error)\"}")
  exit(1)
}

var results: [[String: Any]] = []
for obs in (request.results ?? []) {
  guard let top = obs.topCandidates(1).first else { continue }
  let box = obs.boundingBox
  results.append([
    "text": top.string,
    "confidence": Double(top.confidence),
    "x": Double(box.origin.x),
    "y": Double(box.origin.y),
    "w": Double(box.width),
    "h": Double(box.height),
  ])
}

let json = try! JSONSerialization.data(withJSONObject: results, options: [])
print(String(data: json, encoding: .utf8)!)
