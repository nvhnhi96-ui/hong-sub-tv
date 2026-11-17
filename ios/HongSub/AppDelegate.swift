import UIKit
import AVFoundation

/// Hóng Sub for iPhone and iPad: the very same Hóng Sub page as the Windows and Android apps, in a WKWebView.
/// The app adds what a page cannot do: PS5 / PS4 Remote Play (the core in rp/mobile, built on chiaki-ng,
/// AGPL-3.0, which also serves the page on 127.0.0.1) and the PlayStation Network sign-in.
@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        /* the Vietnamese voice plays even with the silent switch on, mixed with other sound */
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio, options: [.mixWithOthers])
        try? AVAudioSession.sharedInstance().setActive(true)
        let w = UIWindow(frame: UIScreen.main.bounds)
        w.rootViewController = MainViewController()
        w.makeKeyAndVisible()
        window = w
        return true
    }
}
