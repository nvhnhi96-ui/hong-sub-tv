import UIKit
import WebKit

final class MainViewController: UIViewController, WKScriptMessageHandler, WKNavigationDelegate, WKUIDelegate {
    private var web: WKWebView!
    private var port: Int32 = 0
    private var token = ""
    private let bg = UIColor(red: 16 / 255, green: 18 / 255, blue: 22 / 255, alpha: 1)

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = bg
        token = (0..<18).map { _ in String(format: "%02x", UInt8.random(in: 0...255)) }.joined()
        let root = Bundle.main.bundlePath + "/web"
        port = hsrp_start(47123, token, root)

        let cfg = WKWebViewConfiguration()
        cfg.allowsInlineMediaPlayback = true
        cfg.mediaTypesRequiringUserActionForPlayback = []
        let ver = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? ""
        let js = "window.HSIOS={port:\(port),token:'\(token)',ver:'\(ver)'};"
        cfg.userContentController.addUserScript(WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        cfg.userContentController.add(self, name: "hs")

        web = WKWebView(frame: .zero, configuration: cfg)
        web.translatesAutoresizingMaskIntoConstraints = false
        web.navigationDelegate = self
        web.uiDelegate = self
        web.isOpaque = false
        web.backgroundColor = bg
        web.scrollView.backgroundColor = bg
        if #available(iOS 16.4, *) { web.isInspectable = true }
        view.addSubview(web)
        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            web.topAnchor.constraint(equalTo: g.topAnchor),
            web.bottomAnchor.constraint(equalTo: g.bottomAnchor),
            web.leadingAnchor.constraint(equalTo: g.leadingAnchor),
            web.trailingAnchor.constraint(equalTo: g.trailingAnchor)
        ])
        UIApplication.shared.isIdleTimerDisabled = true   // the phone stays awake while translating
        load()
    }

    private func load() {
        guard port > 0, let u = URL(string: "http://127.0.0.1:\(port)/index.html") else {
            web.loadHTMLString("<body style='background:#101216;color:#fff;font:17px -apple-system;padding:24px'>Không mở được Hóng Sub. Tắt hẳn app rồi mở lại.</body>", baseURL: nil)
            return
        }
        web.load(URLRequest(url: u))
    }

    // MARK: what the page asks of the app

    func userContentController(_ uc: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let d = message.body as? [String: Any], let cmd = d["cmd"] as? String, let id = d["id"] as? String else { return }
        switch cmd {
        case "psnLogin":
            PsnLogin.present(from: self) { [weak self] res in self?.reply(id, res) }
        case "psnCancel":
            PsnLogin.cancel()
            reply(id, ["ok": true])
        default:
            reply(id, ["ok": false, "err": "unknown"])
        }
    }

    private func reply(_ id: String, _ obj: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: data, encoding: .utf8),
              let idData = try? JSONSerialization.data(withJSONObject: [id]), let ids = String(data: idData, encoding: .utf8) else { return }
        DispatchQueue.main.async { self.web.evaluateJavaScript("window.hsNat&&window.hsNat(\(ids)[0],\(s))", completionHandler: nil) }
    }

    // MARK: links open in Safari, the page stays

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if let u = action.request.url, let scheme = u.scheme?.lowercased(), scheme == "http" || scheme == "https",
           u.host != "127.0.0.1", action.targetFrame?.isMainFrame ?? true {
            UIApplication.shared.open(u)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if let u = action.request.url { UIApplication.shared.open(u) }
        return nil
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) { load() }

    /* the camera, for "Camera chĩa vào TV" (iOS asks the person once) */
    @available(iOS 15.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo,
                 type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(origin.host == "127.0.0.1" ? .grant : .prompt)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler() })
        present(a, animated: true)
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = UIAlertController(title: nil, message: message, preferredStyle: .alert)
        a.addAction(UIAlertAction(title: "Hủy", style: .cancel) { _ in completionHandler(false) })
        a.addAction(UIAlertAction(title: "OK", style: .default) { _ in completionHandler(true) })
        present(a, animated: true)
    }
}
