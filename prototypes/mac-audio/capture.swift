// Experimental ScreenCaptureKit application-audio capture. macOS 13+, Swift 5 language mode.
// Not invoked by Current. Requires the user's explicit macOS Screen Recording permission.
// Outputs only interleaved Float32 PCM (48 kHz stereo); never screen frames or media URLs.
import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import Darwin

@available(macOS 13.0, *)
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    private var stream: SCStream?
    private let queue = DispatchQueue(label: "Current.AudioCapture")
    func start(bundleID: String) async throws {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
        guard let display = content.displays.first else { throw CaptureError.noDisplay }
        let included = content.applications.filter { $0.bundleIdentifier == bundleID }
        guard !included.isEmpty else { throw CaptureError.browserMissing }
        // Display-filter exclusion allows only the explicitly selected browser application.
        let excluded = content.applications.filter { $0.bundleIdentifier != bundleID }
        let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
        let config = SCStreamConfiguration()
        config.capturesAudio = true
        config.excludesCurrentProcessAudio = true
        config.sampleRate = 48_000
        config.channelCount = 2
        config.width = 2
        config.height = 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
        let capture = SCStream(filter: filter, configuration: config, delegate: self)
        try capture.addStreamOutput(self, type: .audio, sampleHandlerQueue: queue)
        stream = capture
        try await capture.startCapture()
        FileHandle.standardError.write(Data("Capture started. All audio from the selected browser may be included.\n".utf8))
    }
    func stop() async { try? await stream?.stopCapture(); stream = nil }
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        FileHandle.standardError.write(Data("ScreenCaptureKit stopped. Check permission and browser availability.\n".utf8))
        exit(3)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sample.isValid,
              let description = CMSampleBufferGetFormatDescription(sample),
              let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(description),
              let format = AVAudioFormat(streamDescription: asbd) else { return }
        let count = CMSampleBufferGetNumSamples(sample)
        guard count > 0, count <= 48_000,
              format.sampleRate == 48_000, format.channelCount == 2,
              format.commonFormat == .pcmFormatFloat32,
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else {
            FileHandle.standardError.write(Data("Unsupported capture PCM format. Refusing to output invalid audio.\n".utf8)); exit(4)
        }
        buffer.frameLength = AVAudioFrameCount(count)
        guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(count), into: buffer.mutableAudioBufferList) == noErr else { return }
        guard let channels = buffer.floatChannelData else { return }
        var output = [Float](repeating: 0, count: count * 2)
        if format.isInterleaved {
            output.withUnsafeMutableBufferPointer { target in target.baseAddress!.update(from: channels[0], count: count * 2) }
        } else {
            for frame in 0..<count { output[frame * 2] = channels[0][frame]; output[frame * 2 + 1] = channels[1][frame] }
        }
        do { try output.withUnsafeBytes { bytes in try FileHandle.standardOutput.write(contentsOf: Data(bytes)) } }
        catch { exit(0) } // downstream has closed; no background capture remains
    }
}
enum CaptureError: Error { case noDisplay, browserMissing }

@main struct Main {
    static func main() async {
        guard #available(macOS 13.0, *) else { fputs("macOS 13 or later is required.\n", stderr); exit(2) }
        let args = CommandLine.arguments
        let bundle = args.count > 1 ? args[1] : "com.google.Chrome"
        guard ["com.google.Chrome", "com.apple.Safari"].contains(bundle) else { fputs("Choose Chrome or Safari.\n", stderr); exit(2) }
        let capture = Capture()
        signal(SIGINT, SIG_IGN); signal(SIGTERM, SIG_IGN)
        let interrupted = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
        let terminated = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
        let shutdown = { Task { await capture.stop(); exit(0) }; return () }
        interrupted.setEventHandler(handler: shutdown); terminated.setEventHandler(handler: shutdown)
        interrupted.resume(); terminated.resume()
        do { try await capture.start(bundleID: bundle); while !Task.isCancelled { try await Task.sleep(nanoseconds: 1_000_000_000) } }
        catch { fputs("Capture could not start. Open the selected browser, connect a display, and grant Screen & System Audio Recording permission to the launcher. No audio was captured.\n", stderr); exit(2) }
    }
}
